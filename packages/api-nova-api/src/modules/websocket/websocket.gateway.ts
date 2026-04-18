import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ServerMetricsService } from '../servers/services/server-metrics.service';
import { ServerHealthService } from '../servers/services/server-health.service';
import { AlertService } from './services/alert.service';
import { NotificationService } from './services/notification.service';
import { WebSocketMetricsService } from './services/websocket-metrics.service';
import { RuntimeAssetsService } from '../runtime-assets/services/runtime-assets.service';
import { RuntimeObservabilityService } from '../runtime-observability/services/runtime-observability.service';

interface ClientInfo {
  id: string;
  connectedAt: Date;
  subscribedRooms: Set<string>;
  lastActivity: Date;
}

@WebSocketGateway({
  cors: {
    origin: ['http://localhost:9000', 'http://localhost:9001', 'http://localhost:5173'],
    methods: ['GET', 'POST'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
  },
  namespace: '/monitoring',
  // 添加WebSocket特定配置
  transports: ['websocket', 'polling'],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000,
})
export class MonitoringGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(MonitoringGateway.name);
  private readonly clients = new Map<string, ClientInfo>();
  private readonly rooms = new Set<string>();
  private readonly roomMembers = new Map<string, Set<string>>(); // 内部房间成员跟踪
  private readonly debugEnabled = process.env.WS_DEBUG === 'true';

  private d(message: string, meta?: any) {
    if (!this.debugEnabled) return;
    if (meta !== undefined) {
      this.logger.log(`[DEBUG] ${message} ${typeof meta === 'string' ? meta : JSON.stringify(meta)}`);
    } else {
      this.logger.log(`[DEBUG] ${message}`);
    }
  }

  private getNamespace(): any {
    // 统一获取命名空间实例
    return (this.server as any)?.of?.('/monitoring') || this.server;
  }

  private addRoomMember(room: string, clientId: string) {
    let set = this.roomMembers.get(room);
    if (!set) {
      set = new Set<string>();
      this.roomMembers.set(room, set);
    }
    set.add(clientId);
  }

  private removeRoomMember(room: string, clientId: string) {
    const set = this.roomMembers.get(room);
    if (set) {
      set.delete(clientId);
      if (set.size === 0) this.roomMembers.delete(room);
    }
  }

  private removeSubscription(client: Socket, room: string) {
    client.leave(room);
    this.removeRoomMember(room, client.id);

    const clientInfo = this.clients.get(client.id);
    if (clientInfo) {
      clientInfo.subscribedRooms.delete(room);
      clientInfo.lastActivity = new Date();
    }

    client.emit('unsubscription-confirmed', {
      room,
      timestamp: new Date().toISOString(),
    });
  }

  private getRoomInternalSize(room: string) {
    return this.roomMembers.get(room)?.size || 0;
  }

  private emitToRoom(room: string, event: string, payload: any) {
    const ns = this.getNamespace();
    // 如果 adapter 丢失但内部记录存在, 逐个成员直发
    const internal = this.roomMembers.get(room);
    if (!internal || internal.size === 0) return;
    try {
      if (ns?.to) {
        ns.to(room).emit(event, payload);
      } else {
        // 兜底: 直接对每个 socket 单播
        internal.forEach(id => {
          const s = ns.sockets?.get?.(id) || (ns.sockets && (ns.sockets as any)[id]);
          s?.emit(event, payload);
        });
      }
    } catch (e) {
      this.logger.error(`[emitToRoom] Failed emit to ${room}:`, e);
    }
  }

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly serverMetrics: ServerMetricsService,
    private readonly serverHealth: ServerHealthService,
    private readonly alertService: AlertService,
    private readonly notificationService: NotificationService,
    private readonly wsMetricsService: WebSocketMetricsService,
    private readonly runtimeAssetsService: RuntimeAssetsService,
    private readonly runtimeObservabilityService: RuntimeObservabilityService,
  ) {}

  afterInit(server: Server) {
    this.logger.log('WebSocket Gateway initialized');
    this.setupEventListeners();
  }

  handleConnection(client: Socket) {
    // 仅关键日志
    const clientInfo: ClientInfo = {
      id: client.id,
      connectedAt: new Date(),
      subscribedRooms: new Set(),
      lastActivity: new Date(),
    };
    this.clients.set(client.id, clientInfo);
    this.logger.log(`Client connected: ${client.id}`);
    this.d(`Handshake query: ${JSON.stringify(client.handshake.query)}`);

    if (this.debugEnabled) {
      // 可选调试事件监听
      client.onAny((eventName, ...args) => {
        this.d(`Received event '${eventName}' from ${client.id}`);
      });
    }

    client.on('disconnecting', (reason) => {
      this.d(`Client ${client.id} disconnecting: ${reason}`);
    });

    client.on('error', (error) => {
      this.logger.error(`Client ${client.id} error: ${error}`);
    });

    this.wsMetricsService.recordConnection(client);

    client.emit('connection-established', {
      clientId: client.id,
      timestamp: new Date().toISOString(),
      availableRooms: Array.from(this.rooms),
      transport: client.conn.transport.name,
      upgraded: client.conn.upgraded,
    });

    this.sendInitialData(client);
  }

  handleDisconnect(client: Socket) {
    const clientInfo = this.clients.get(client.id);
    if (clientInfo) {
      this.logger.log(`Client disconnected: ${client.id} from ${client.handshake.address}`);
      this.logger.log(`Disconnection reason: ${client.disconnected ? 'client initiated' : 'server initiated'}`);
      this.logger.log(`Subscribed rooms before disconnect: ${Array.from(clientInfo.subscribedRooms)}`);
      
      // 清理客户端的所有房间订阅
      clientInfo.subscribedRooms.forEach(room => {
        client.leave(room);
        this.removeRoomMember(room, client.id);
        this.logger.log(`Client ${client.id} left room: ${room}`);
      });
      
      this.clients.delete(client.id);
    }

    // 记录WebSocket断开连接指标
    this.wsMetricsService.recordDisconnection(client.id, 'client_disconnect');
  }

  @SubscribeMessage('subscribe-runtime-overview')
  handleSubscribeRuntimeOverview(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { interval?: number } = {},
  ) {
    const room = 'runtime-overview';
    client.join(room);
    this.rooms.add(room);
    this.addRoomMember(room, client.id);

    const clientInfo = this.clients.get(client.id);
    if (clientInfo) {
      clientInfo.subscribedRooms.add(room);
      clientInfo.lastActivity = new Date();
    }

    this.wsMetricsService.recordSubscription(client.id, room);
    void this.sendRuntimeOverview(client);
    client.emit('subscription-confirmed', {
      room,
      interval: data.interval || 5000,
      timestamp: new Date().toISOString(),
    });
  }

  @SubscribeMessage('subscribe-runtime-asset')
  async handleSubscribeRuntimeAsset(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { serverId?: string; runtimeAssetId?: string; interval?: number },
  ) {
    try {
      const runtimeAssetId =
        data.runtimeAssetId ||
        (data.serverId ? await this.resolveRuntimeAssetIdByServerId(data.serverId) : undefined);
      if (!runtimeAssetId) {
        return;
      }

      const room = `runtime-asset-${runtimeAssetId}`;
      client.join(room);
      this.rooms.add(room);
      this.addRoomMember(room, client.id);

      const clientInfo = this.clients.get(client.id);
      if (clientInfo) {
        clientInfo.subscribedRooms.add(room);
        clientInfo.lastActivity = new Date();
      }

      this.wsMetricsService.recordSubscription(client.id, room);
      await this.sendRuntimeAssetObservability(client, runtimeAssetId);
      client.emit('subscription-confirmed', {
        room,
        runtimeAssetId,
        interval: data.interval || 5000,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('subscribe-runtime-asset error', error);
    }
  }

  @SubscribeMessage('subscribe-runtime-events')
  async handleSubscribeRuntimeEvents(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { level?: string[]; serverId?: string; runtimeAssetId?: string } = {},
  ) {
    const runtimeAssetId =
      data.runtimeAssetId ||
      (data.serverId ? await this.resolveRuntimeAssetIdByServerId(data.serverId) : undefined);
    const room = runtimeAssetId ? `runtime-events-${runtimeAssetId}` : 'runtime-events';

    client.join(room);
    this.rooms.add(room);
    this.addRoomMember(room, client.id);

    const clientInfo = this.clients.get(client.id);
    if (clientInfo) {
      clientInfo.subscribedRooms.add(room);
      clientInfo.lastActivity = new Date();
    }

    this.wsMetricsService.recordSubscription(client.id, room);
    client.emit('subscription-confirmed', {
      room,
      runtimeAssetId,
      level: data.level || ['info', 'warning', 'error', 'critical'],
      timestamp: new Date().toISOString(),
    });
  }

  private async sendRuntimeOverview(client: Socket) {
    try {
      client.emit('runtime-overview', await this.buildRuntimeOverviewPayload());
    } catch (error) {
      this.logger.error('Failed to send runtime overview:', error);
    }
  }

  private async sendRuntimeAssetObservability(client: Socket, runtimeAssetId: string) {
    try {
      client.emit(
        'runtime-asset-observability',
        await this.buildRuntimeAssetPayload(runtimeAssetId),
      );
    } catch (error) {
      this.logger.error(`Failed to send runtime asset observability for ${runtimeAssetId}:`, error);
    }
  }

  /**
   * 监听进程信息变化事件
   */
  @OnEvent('process.info.updated')
  async handleProcessInfoUpdated(payload: { serverId: string; processInfo: any; timestamp?: Date }) {
    this.logger.debug(`[handleProcessInfoUpdated] Processing event for server ${payload.serverId}`);
    this.logger.debug(`[handleProcessInfoUpdated] ProcessInfo data:`, {
      hasResourceMetrics: !!payload.processInfo?.resourceMetrics,
      resourceMetrics: payload.processInfo?.resourceMetrics,
      processInfoKeys: payload.processInfo ? Object.keys(payload.processInfo) : [],
    });

    const runtimeAssetId = await this.resolveRuntimeAssetIdByServerId(payload.serverId);
    if (runtimeAssetId && this.getRoomInternalSize(`runtime-asset-${runtimeAssetId}`) > 0) {
      this.emitToRoom(
        `runtime-asset-${runtimeAssetId}`,
        'runtime-asset-observability',
        await this.buildRuntimeAssetPayload(runtimeAssetId, {
          managedServerId: payload.serverId,
          liveProcessInfo: payload.processInfo,
          liveProcessTimestamp: (payload.timestamp || new Date()).toISOString(),
        }),
      );
    }
  }

  /**
   * 监听进程日志事件
   */
  @OnEvent('process.logs.updated')
  async handleProcessLogsUpdated(payload: { serverId: string; logData: any; timestamp?: Date }) {
    const timestamp = payload.timestamp || new Date();
    this.logger.debug(`[handleProcessLogsUpdated] Processing log event for server ${payload.serverId}`);
    this.logger.debug(`[handleProcessLogsUpdated] LogData:`, {
      hasLogData: !!payload.logData,
      logDataKeys: payload.logData ? Object.keys(payload.logData) : [],
      logDataType: typeof payload.logData,
    });

    if (payload.logData && payload.logData.isMCPConnectionLog) {
      const mcpRoom = `mcp-connections-${payload.serverId}`;
      const mcpAllRoom = 'mcp-connections-all';

      const mcpLogData = {
        serverId: payload.serverId,
        connectionEvent: payload.logData.connectionEvent,
        timestamp: timestamp.toISOString(),
      };

      if (this.getRoomInternalSize(mcpRoom) > 0) {
        this.emitToRoom(mcpRoom, 'mcpConnectionLog', mcpLogData);
        this.logger.debug(`[handleProcessLogsUpdated] Emitted MCP connection log to room ${mcpRoom}`);
      }

      if (this.getRoomInternalSize(mcpAllRoom) > 0) {
        this.emitToRoom(mcpAllRoom, 'mcpConnectionLog', mcpLogData);
        this.logger.debug(`[handleProcessLogsUpdated] Emitted MCP connection log to room ${mcpAllRoom}`);
      }
    }

    await this.emitRuntimeNativeLog(payload.serverId, {
      level: String(payload.logData?.level || 'info'),
      message: String(payload.logData?.message || 'Process log updated'),
      source: String(payload.logData?.source || 'process'),
      timestamp,
      details: payload.logData,
    });
  }

  /**
   * 设置事件监听器
   */
  private async sendAlert(alert: {
    type: string;
    severity: string;
    serverId?: string;
    message: string;
    source?: string;
    timestamp: Date;
  }) {
    const socketContext = alert.serverId
      ? await this.getRuntimeAssetSocketContextByServerId(alert.serverId)
      : null;

    if (this.getRoomInternalSize('runtime-alerts') > 0) {
      this.emitToRoom('runtime-alerts', 'runtime-alert', {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        type: alert.type,
        severity: alert.severity,
        runtimeAssetId: socketContext?.runtimeAssetId,
        runtimeAssetName:
          socketContext?.runtimeAsset?.displayName || socketContext?.runtimeAsset?.name,
        runtimeAssetType: socketContext?.runtimeAsset?.type,
        managedServerId: alert.serverId,
        managedServerName: socketContext?.managedServerName,
        message: alert.message,
        source: alert.source,
        timestamp: alert.timestamp.toISOString(),
      });
    }
  }

  private async sendInitialData(client: Socket) {
    try {
      await this.sendRuntimeOverview(client);
    } catch (error) {
      this.logger.error('Failed to send initial data:', error);
    }
  }

  private setupEventListeners() {
    // 监听系统级别的事件
    this.eventEmitter.on('system.alert', (alert) => {
      void this.sendAlert(alert);
    });

    // 监听性能阈值告警
    this.eventEmitter.on('performance.threshold.exceeded', (data) => {
      void this.sendAlert({
        type: 'performance-threshold',
        severity: 'warning',
        serverId: data.serverId,
        message: `Performance threshold exceeded: ${data.metric} = ${data.value} (threshold: ${data.threshold})`,
        timestamp: new Date(),
      });
    });

    // 监听MCP连接变化事件
    this.eventEmitter.on('mcp.connection.changed', (data) => {
      this.handleMCPConnectionChanged(data);
    });

    // 监听MCP连接统计请求响应
    this.eventEmitter.on('mcp.connection.stats.response', (data) => {
      this.handleMCPConnectionStatsResponse(data);
    });

    // 监听所有MCP连接统计请求响应
    this.eventEmitter.on('mcp.connection.stats.response.all', (data) => {
      this.handleAllMCPConnectionStatsResponse(data);
    });

  }

  private async buildRuntimeOverviewPayload() {
    return {
      data: await this.runtimeObservabilityService.getManagementOverview({
        days: 7,
        limit: 20,
      }),
      timestamp: new Date().toISOString(),
    };
  }

  private async buildRuntimeAssetPayload(
    runtimeAssetId: string,
    extras?: Record<string, unknown>,
  ) {
    return {
      runtimeAssetId,
      data: await this.runtimeAssetsService.getRuntimeAssetObservability(runtimeAssetId),
      ...(extras || {}),
      timestamp: new Date().toISOString(),
    };
  }

  private async resolveRuntimeAssetIdByServerId(serverId: string) {
    const context = await this.getRuntimeAssetSocketContextByServerId(serverId);
    return context?.runtimeAssetId;
  }

  private async getRuntimeAssetSocketContextByServerId(serverId: string) {
    try {
      const runtimeAsset = await this.runtimeAssetsService.getManagedServerRuntimeAsset(serverId);
      const observability = await this.runtimeAssetsService.getManagedServerObservability(serverId);
      return {
        runtimeAssetId: runtimeAsset.id,
        runtimeAsset,
        managedServerName:
          observability?.normalizedObservability?.currentState?.managedServer?.name ||
          undefined,
      };
    } catch {
      return null;
    }
  }

  private async emitRuntimeNativeServerEvent(
    serverId: string,
    input: {
      eventName: string;
      status: string;
      summary: string;
      timestamp: Date;
      details?: Record<string, unknown>;
    },
  ) {
    const socketContext = await this.getRuntimeAssetSocketContextByServerId(serverId);
    const runtimeAssetId = socketContext?.runtimeAssetId;
    const payload = {
      runtimeAssetId,
      runtimeAssetName: socketContext?.runtimeAsset?.displayName || socketContext?.runtimeAsset?.name,
      runtimeAssetType: socketContext?.runtimeAsset?.type,
      managedServerId: serverId,
      managedServerName: socketContext?.managedServerName,
      eventName: input.eventName,
      severity:
        input.status === 'failed'
          ? 'error'
          : input.status === 'degraded'
            ? 'warning'
            : 'info',
      family: input.eventName.includes('.health')
        ? 'runtime.health'
        : input.eventName.includes('.status')
          ? 'runtime.lifecycle'
          : 'runtime.control',
      status: input.status,
      summary: input.summary,
      details: input.details || null,
      timestamp: input.timestamp.toISOString(),
    };

    this.server.emit('runtime-event', payload);
    if (runtimeAssetId) {
      this.emitToRoom(`runtime-events-${runtimeAssetId}`, 'runtime-event', payload);
      if (this.getRoomInternalSize(`runtime-asset-${runtimeAssetId}`) > 0) {
        this.emitToRoom(
          `runtime-asset-${runtimeAssetId}`,
          'runtime-asset-observability',
          await this.buildRuntimeAssetPayload(runtimeAssetId),
        );
      }
    }
    if (this.getRoomInternalSize('runtime-events') > 0) {
      this.emitToRoom('runtime-events', 'runtime-event', payload);
    }
  }

  private async emitRuntimeNativeLog(
    serverId: string,
    input: {
      level: string;
      message: string;
      source: string;
      timestamp: Date;
      details?: Record<string, unknown>;
    },
  ) {
    const socketContext = await this.getRuntimeAssetSocketContextByServerId(serverId);
    const runtimeAssetId = socketContext?.runtimeAssetId;
    const payload = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      runtimeAssetId,
      runtimeAssetName: socketContext?.runtimeAsset?.displayName || socketContext?.runtimeAsset?.name,
      runtimeAssetType: socketContext?.runtimeAsset?.type,
      managedServerId: serverId,
      managedServerName: socketContext?.managedServerName,
      level: input.level,
      message: input.message,
      source: input.source,
      details: input.details || null,
      timestamp: input.timestamp.toISOString(),
    };

    if (this.getRoomInternalSize('runtime-events') > 0) {
      this.emitToRoom('runtime-events', 'runtime-log', payload);
    }
    if (runtimeAssetId && this.getRoomInternalSize(`runtime-events-${runtimeAssetId}`) > 0) {
      this.emitToRoom(`runtime-events-${runtimeAssetId}`, 'runtime-log', payload);
    }
  }

  /**
   * 获取连接统计
   */
  getConnectionStats() {
    return {
      totalClients: this.clients.size,
      activeRooms: Array.from(this.rooms),
      clientDetails: Array.from(this.clients.entries()).map(([id, info]) => ({
        id,
        connectedAt: info.connectedAt,
        subscribedRooms: Array.from(info.subscribedRooms),
        lastActivity: info.lastActivity,
      })),
    };
  }

  /**
   * 处理MCP连接变化事件
   */
  private handleMCPConnectionChanged(data: {
    serverId: string;
    connectionEvent: any;
    stats: any;
    timestamp: Date;
  }) {
    const mcpRoom = `mcp-connections-${data.serverId}`;
    const mcpAllRoom = 'mcp-connections-all';
    
    const eventData = {
      serverId: data.serverId,
      connectionEvent: data.connectionEvent,
      stats: data.stats,
      timestamp: data.timestamp.toISOString(),
    };
    
    // 发送到特定服务器的MCP连接订阅者
    if (this.getRoomInternalSize(mcpRoom) > 0) {
      this.emitToRoom(mcpRoom, 'mcpConnectionChanged', eventData);
      this.logger.debug(`[handleMCPConnectionChanged] Emitted to room ${mcpRoom}`);
    }
    
    // 发送到所有MCP连接订阅者
    if (this.getRoomInternalSize(mcpAllRoom) > 0) {
      this.emitToRoom(mcpAllRoom, 'mcpConnectionChanged', eventData);
      this.logger.debug(`[handleMCPConnectionChanged] Emitted to room ${mcpAllRoom}`);
    }
  }

  /**
   * 处理MCP连接统计响应
   */
  private handleMCPConnectionStatsResponse(data: {
    serverId: string;
    stats: any;
    clientId: string;
  }) {
    const client = this.server.sockets.sockets.get(data.clientId);
    if (client) {
      client.emit('mcp-connection-stats', {
        serverId: data.serverId,
        stats: data.stats,
        timestamp: new Date().toISOString(),
      });
      this.logger.debug(`[handleMCPConnectionStatsResponse] Sent stats to client ${data.clientId}`);
    }
  }

  /**
   * 处理所有MCP连接统计响应
   */
  private handleAllMCPConnectionStatsResponse(data: {
    allStats: Record<string, any>;
    clientId: string;
  }) {
    const client = this.server.sockets.sockets.get(data.clientId);
    if (client) {
      client.emit('all-mcp-connection-stats', {
        allStats: data.allStats,
        timestamp: new Date().toISOString(),
      });
      this.logger.debug(`[handleAllMCPConnectionStatsResponse] Sent all stats to client ${data.clientId}`);
    }
  }



  /**
   * 广播系统通知
   */
  broadcastSystemNotification(notification: {
    type: string;
    title: string;
    message: string;
    severity?: string;
  }) {
    this.server.emit('system-notification', {
      ...notification,
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * 调试：转储房间信息
   */
  @SubscribeMessage('debug-dump-rooms')
  handleDebugDumpRooms(@ConnectedSocket() client: Socket) {
    try {
      const nsAdapter: any = (this.server as any)?.of?.('/monitoring')?.adapter || (this.server as any)?.adapter;
      const adapterRooms: Record<string, any> = {};
      if (nsAdapter?.rooms) {
        for (const [name, set] of nsAdapter.rooms) {
          adapterRooms[name] = Array.from(set);
        }
      }
      const clientInfo = this.clients.get(client.id);
      const payload = {
        serverHasAdapter: !!nsAdapter,
        adapterRoomNames: Object.keys(adapterRooms),
        adapterRooms,
        clientId: client.id,
        clientRooms: Array.from(client.rooms),
        trackedClientRooms: clientInfo ? Array.from(clientInfo.subscribedRooms) : [],
        timestamp: new Date().toISOString(),
      };
      this.logger.log(`[debug-dump-rooms] Emitting rooms dump to ${client.id}`);
      client.emit('rooms-dump', payload);
    } catch (e) {
      this.logger.error('[debug-dump-rooms] error', e);
    }
  }
}
