"use strict";
// Complete quiesced PostgreSQL + private files + configuration restore into an empty database.
// Only a new, owned loopback cluster is used. Synthetic secrets travel in a separate encrypted vault.
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");
const {
  randomUUID,
  randomBytes,
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
} = require("node:crypto");
const root = path.resolve(__dirname, ".."),
  api = path.join(root, "packages/api-nova-api");
fs.mkdirSync(path.join(root, ".tmp"), { recursive: true });
const directory = fs.mkdtempSync(path.join(root, ".tmp/obs-16-04-backup-"));
const pgdata = path.join(directory, "pgdata"),
  sourceFiles = path.join(directory, "source"),
  targetFiles = path.join(directory, "restored"),
  archive = path.join(directory, "backup"),
  vault = path.join(directory, "separate-secret-vault");
for (const p of [sourceFiles, archive, vault]) fs.mkdirSync(p);
const sha = (v) => createHash("sha256").update(v).digest("hex");
const secrets = [
  randomBytes(32).toString("hex"),
  randomBytes(32).toString("hex"),
  randomBytes(32).toString("hex"),
];
const [jwtSecret, webhookSecret, commandSecret] = secrets;
const evidence = {
  marker: "OBS_16_04_BACKUP_RESTORE_RUNNING",
  startedAt: new Date().toISOString(),
  platform: process.platform,
  node: process.version,
  steps: [],
  commit: spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  }).stdout.trim(),
  notCovered: [
    "production host/account/ACL and encrypted backup storage",
    "Linux or SQLite restore",
    "online concurrent-writer backup",
    "production secret-manager integration",
    "full API login or real Gateway collection (records use actual ingest service)",
    "automatic worker scheduling (runOnce used)",
    "production RPO/RTO SLA",
  ],
};
let pgStarted = false,
  pgPort,
  admin,
  current,
  receiver;
const openedDatabases = [],
  openedApps = [],
  openedPayloads = [];
const redact = (v) =>
  secrets.reduce((s, key) => s.split(key).join("[redacted]"), String(v));
const save = () =>
  fs.writeFileSync(
    path.join(directory, "evidence.json"),
    redact(JSON.stringify(evidence, null, 2)) + "\n",
  );
async function step(id, fn) {
  try {
    const details = await fn();
    evidence.steps.push({ id, passed: true, details });
    save();
    console.log("PASS " + id);
    return details;
  } catch (e) {
    evidence.steps.push({ id, passed: false, error: e.message });
    save();
    throw e;
  }
}
function pgTool(name) {
  return process.env.API_NOVA_TEST_PG_BIN
    ? path.join(
        process.env.API_NOVA_TEST_PG_BIN,
        name + (process.platform === "win32" ? ".exe" : ""),
      )
    : name;
}
async function pgRun(name, args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^PG|^DATABASE_URL$/i.test(k)),
  );
  const fd = fs.openSync(path.join(directory, "pg-tools.log"), "a");
  const c = spawn(pgTool(name), args, {
    env,
    windowsHide: true,
    stdio: ["ignore", fd, fd],
  });
  fs.closeSync(fd);
  await new Promise((resolve, reject) => {
    c.once("error", reject);
    c.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(name + " failed: " + code)),
    );
  });
}
async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
function inventory(dir, rel = "") {
  const rows = [];
  for (const e of fs.readdirSync(path.join(dir, rel), {
    withFileTypes: true,
  })) {
    const name = path.join(rel, e.name);
    assert.equal(e.isSymbolicLink(), false);
    if (e.isDirectory()) rows.push(...inventory(dir, name));
    else {
      assert.ok(e.isFile());
      const b = fs.readFileSync(path.join(dir, name));
      rows.push({
        path: name.replaceAll("\\", "/"),
        size: b.length,
        sha256: sha(b),
      });
    }
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}
let DataSource,
  ConfigService,
  JwtService,
  Module,
  NestFactory,
  NotFoundException,
  entities,
  EventEntity,
  User,
  Role,
  Permission,
  AuditLog,
  UserService,
  AuditService,
  Store,
  PayloadStore,
  PayloadService,
  PayloadController,
  AccessGuard,
  ApiFilter,
  CommandStore,
  CursorService,
  Subscriptions,
  DeliveryWorker,
  Outbox,
  authorize,
  captureAuditBody,
  tokens,
  options;
async function loadProduct() {
  Object.assign(process.env, {
    NODE_ENV: "test",
    DB_TYPE: "postgres",
    DB_HOST: "127.0.0.1",
    DB_PORT: String(pgPort),
    DB_USERNAME: "obs_backup_fixture",
    DB_PASSWORD: "",
    DB_DATABASE: "obs_source",
    DB_SSL: "false",
    JWT_SECRET: jwtSecret,
  });
  require("reflect-metadata");
  ({ DataSource } = require("typeorm"));
  ({ ConfigService } = require("@nestjs/config"));
  ({ JwtService } = require("@nestjs/jwt"));
  ({ Module, NotFoundException } = require("@nestjs/common"));
  ({ NestFactory } = require("@nestjs/core"));
  ({ captureAuditBody } = require("api-nova-parser"));
  const load = (f) => require(path.join(api, "dist/src", f));
  await load("config/environment.js").applicationConfigModule;
  options = load("database/database-options.js").buildDatabaseOptions();
  entities = load("database/entities/runtime-call-observability.entity.js");
  ({ RuntimeObservabilityEventEntity: EventEntity } = load(
    "database/entities/runtime-observability-event.entity.js",
  ));
  ({ User } = load("database/entities/user.entity.js"));
  ({ Role } = load("database/entities/role.entity.js"));
  ({ Permission } = load("database/entities/permission.entity.js"));
  ({ AuditLog } = load("database/entities/audit-log.entity.js"));
  ({ UserService } = load("modules/security/services/user.service.js"));
  ({ AuditService } = load("modules/security/services/audit.service.js"));
  tokens = load("modules/security/management-access-token.js");
  const obs = (n) => load("modules/call-observability/" + n + ".js");
  ({ CallObservabilityStore: Store } = obs("call-observability.store"));
  ({ CallObservabilityPayloadStore: PayloadStore } = obs(
    "call-observability-payload.store",
  ));
  ({ CallObservabilityPayloadsService: PayloadService } = obs(
    "call-observability-payloads.service",
  ));
  ({ CallObservabilityPayloadsController: PayloadController } = obs(
    "call-observability-payloads.controller",
  ));
  ({ ObservabilityAccessGuard: AccessGuard } = obs(
    "call-observability-access.guard",
  ));
  ({ ObservabilityApiExceptionFilter: ApiFilter } = obs(
    "call-observability-api.contract",
  ));
  ({ ObservabilityCommandStore: CommandStore } = obs(
    "call-observability-command.store",
  ));
  ({ ObservabilityCursorService: CursorService } = obs(
    "call-observability-cursor.service",
  ));
  ({ CallObservabilitySubscriptionsService: Subscriptions } = obs(
    "call-observability-subscriptions.service",
  ));
  ({ CallObservabilityDeliveryWorker: DeliveryWorker } = obs(
    "call-observability-delivery.worker",
  ));
  ({ CallObservabilityOutboxService: Outbox } = obs(
    "call-observability-outbox.service",
  ));
  ({ authorizeObservability: authorize } = obs("call-observability-access"));
}
async function open(name, files, settings, migrate = false) {
  const database = await new DataSource({
    ...options,
    database: name,
    logging: false,
  }).initialize();
  openedDatabases.push(database);
  if (migrate) await database.runMigrations();
  process.env.API_NOVA_OBSERVABILITY_DATA_DIR = path.join(files, "data");
  const payloads = new PayloadStore(),
    store = new Store(database, payloads),
    config = new ConfigService(settings);
  openedPayloads.push(payloads);
  const users = {
    async findUserById(id) {
      const u = await database.getRepository(User).findOne({
        where: { id },
        relations: { roles: { permissions: true } },
      });
      if (!u) throw new NotFoundException();
      return u;
    },
  };
  const audit = new AuditService(
      database.getRepository(AuditLog),
      database.getRepository(User),
    ),
    service = new PayloadService(store, payloads, audit, users),
    jwt = new JwtService();
  class FixtureModule {}
  Module({
    controllers: [PayloadController],
    providers: [
      { provide: PayloadService, useValue: service },
      { provide: UserService, useValue: users },
      { provide: JwtService, useValue: jwt },
      { provide: ConfigService, useValue: config },
      AccessGuard,
      ApiFilter,
    ],
  })(FixtureModule);
  const app = await NestFactory.create(FixtureModule, {
    logger: false,
    abortOnError: false,
  });
  openedApps.push(app);
  app.setGlobalPrefix("api/v1");
  await app.listen(0, "127.0.0.1");
  const base =
    "http://127.0.0.1:" +
    app.getHttpServer().address().port +
    "/api/v1/monitoring/observability/invocations/";
  const outbox = new Outbox(store, config),
    delivery = new DeliveryWorker(store, config, users);
  return {
    database,
    payloads,
    store,
    users,
    outbox,
    delivery,
    subscriptions: new Subscriptions(
      store,
      new CommandStore(store, config),
      config,
      audit,
      new CursorService(config),
    ),
    async request(id, userId, side = "request") {
      const access = userId
        ? jwt.sign(
            { sub: userId, tokenUse: tokens.MANAGEMENT_TOKEN_USE },
            {
              secret: settings.JWT_SECRET,
              algorithm: "HS256",
              issuer: tokens.MANAGEMENT_TOKEN_ISSUER,
              audience: tokens.MANAGEMENT_TOKEN_AUDIENCE,
              expiresIn: "5m",
            },
          )
        : null;
      const r = await fetch(
        base + encodeURIComponent(id) + "/payloads/" + side,
        {
          headers: access ? { authorization: "Bearer " + access } : {},
          signal: AbortSignal.timeout(10000),
        },
      );
      return {
        status: r.status,
        body: await r.json(),
        cache: r.headers.get("cache-control"),
      };
    },
    async close() {
      await app.close();
      await outbox.onModuleDestroy();
      await delivery.onModuleDestroy();
      await payloads.onModuleDestroy();
      await database.destroy();
    },
  };
}
async function dbSnapshot(f) {
  const tables = [];
  for (const { tablename } of await f.database.query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
  )) {
    assert.match(tablename, /^[a-zA-Z0-9_]+$/);
    const rows = await f.database.query(
      'SELECT row_to_json(t) AS row FROM "' + tablename + '" t',
    );
    const canonical = rows.map((r) => JSON.stringify(r.row)).sort();
    tables.push({
      name: tablename,
      rows: canonical.length,
      sha256: sha(canonical.join("\n")),
    });
  }
  return tables;
}
async function main() {
  assert.ok(
    fs.existsSync(path.join(api, "dist/src/main.js")),
    "build API first",
  );
  for (const key of Object.keys(process.env))
    if (
      /^(API_NOVA_|DB_|SUPER_ADMIN_|JWT_|MAIL_|MCP_|PG)/i.test(key) &&
      key !== "API_NOVA_TEST_PG_BIN"
    )
      delete process.env[key];
  pgPort = await freePort();
  await step("isolated_postgresql_cluster", async () => {
    await pgRun("initdb", [
      "-D",
      pgdata,
      "-U",
      "obs_backup_fixture",
      "--auth=trust",
      "--no-locale",
      "--encoding=UTF8",
    ]);
    fs.appendFileSync(
      path.join(pgdata, "postgresql.conf"),
      `\nlisten_addresses = '127.0.0.1'\nport = ${pgPort}\nfsync = on\nsynchronous_commit = on\nmax_connections = 30\n`,
    );
    fs.writeFileSync(
      path.join(pgdata, "pg_hba.conf"),
      "host all obs_backup_fixture 127.0.0.1/32 trust\nlocal all obs_backup_fixture trust\n",
    );
    await pgRun("pg_ctl", [
      "-D",
      pgdata,
      "-l",
      path.join(directory, "postgres.log"),
      "-w",
      "-t",
      "30",
      "start",
    ]);
    pgStarted = true;
    const { Client } = require("pg");
    admin = new Client({
      host: "127.0.0.1",
      port: pgPort,
      user: "obs_backup_fixture",
      database: "postgres",
    });
    await admin.connect();
    await admin.query("CREATE DATABASE obs_source");
    await admin.query("CREATE DATABASE obs_restored");
    return {
      port: pgPort,
      version: (await admin.query("SELECT version()")).rows[0].version,
    };
  });
  const ledgerFile = path.join(directory, "receiver-dedupe-ledger.json");
  fs.writeFileSync(ledgerFile, "{}");
  let dropFirstReply = true;
  receiver = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const sig =
        "sha256=" +
        createHmac("sha256", webhookSecret)
          .update(req.headers["x-apinova-timestamp"] + "." + body)
          .digest("hex");
      if (sig !== req.headers["x-apinova-signature"]) {
        res.writeHead(401);
        return res.end();
      }
      const envelope = JSON.parse(body);
      const { delivery: deliveryMetadata, ...eventContent } = envelope;
      const eventHash = sha(JSON.stringify(eventContent));
      const key = req.headers["x-apinova-delivery-id"],
        eventId = req.headers["x-apinova-event-id"],
        ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8")),
        prior = ledger[key];
      if (
        prior &&
        (prior.eventId !== eventId || prior.eventHash !== eventHash)
      ) {
        res.writeHead(409);
        return res.end();
      }
      ledger[key] = {
        eventId,
        eventHash,
        attemptNumbers: [
          ...(prior?.attemptNumbers || []),
          deliveryMetadata.attemptNo,
        ],
        receipts: (prior?.receipts || 0) + 1,
        sideEffects: 1,
      };
      fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
      if (dropFirstReply) {
        dropFirstReply = false;
        req.socket.destroy();
        return;
      }
      res.writeHead(202);
      res.end("accepted");
    });
  });
  await new Promise((r) => receiver.listen(0, "127.0.0.1", r));
  const receiverPort = receiver.address().port;
  await loadProduct();
  const publicConfig = {
    API_NOVA_OBSERVABILITY_CURSOR_KEY_ID: "backup-fixture-v1",
    API_NOVA_OBSERVABILITY_WEBHOOK_ALLOW_HTTP: "true",
    API_NOVA_OBSERVABILITY_WEBHOOK_ALLOWED_HOSTS: "127.0.0.1:" + receiverPort,
    API_NOVA_OBSERVABILITY_WEBHOOK_ALLOWED_PRIVATE_IPS: "127.0.0.1",
    API_NOVA_OBSERVABILITY_WEBHOOK_SECRET_REFS: "backup-fixture-key",
    API_NOVA_OBSERVABILITY_WEBHOOK_TIMEOUT_MS: "1000",
    API_NOVA_OBSERVABILITY_COLLECTOR_ENABLED: "false",
    API_NOVA_OBSERVABILITY_OUTBOX_ENABLED: "false",
    API_NOVA_OBSERVABILITY_WEBHOOK_ENABLED: "false",
  };
  const secretConfig = {
    JWT_SECRET: jwtSecret,
    API_NOVA_OBSERVABILITY_IDEMPOTENCY_SECRET: commandSecret,
    API_NOVA_OBSERVABILITY_CURSOR_SECRET: commandSecret,
    API_NOVA_OBSERVABILITY_WEBHOOK_SECRETS: JSON.stringify({
      "backup-fixture-key": webhookSecret,
    }),
  };
  current = await open(
    "obs_source",
    sourceFiles,
    { ...publicConfig, ...secretConfig },
    true,
  );
  const asset = randomUUID(),
    sourceId = randomUUID(),
    users = {};
  await step("persisted_accounts_and_subscription", async () => {
    const permissions = await current.database.getRepository(Permission).save(
      [
        "monitoring:read",
        "monitoring:payload:read",
        "monitoring:subscription:manage",
      ].map((name) => ({
        name,
        resource: "monitoring",
        category: "monitoring",
        action: name.split(":").at(-1),
        enabled: true,
      })),
    );
    for (const [name, grants, assets] of [
      ["reader", permissions, [asset]],
      ["denied", permissions.slice(0, 1), [asset]],
      ["otherAsset", permissions, [randomUUID()]],
    ]) {
      const role = await current.database.getRepository(Role).save({
        name: "backup_" + name,
        type: "custom",
        enabled: true,
        metadata: {
          observabilityScope: { mode: "assets", runtimeAssetIds: assets },
        },
        permissions: grants,
      });
      users[name] = await current.database.getRepository(User).save({
        username: "backup_" + name,
        email: name + "@example.invalid",
        password: "$2b$fixture-not-for-login",
        status: "active",
        emailVerified: true,
        roles: [role],
      });
    }
    const scope = authorize(await current.users.findUserById(users.reader.id), [
      "monitoring:subscription:manage",
    ]);
    const subscription = await current.subscriptions.create(
      {
        name: "Backup restore ordinary events",
        destination: {
          type: "webhook",
          url: `http://127.0.0.1:${receiverPort}/events`,
        },
        secretRef: "backup-fixture-key",
        filter: { runtimeAssetIds: [asset] },
        enabled: true,
      },
      {},
      undefined,
      scope,
      randomUUID(),
    );
    return {
      users: Object.fromEntries(
        Object.entries(users).map(([k, u]) => [k, u.id]),
      ),
      subscriptionId: subscription.data.id,
      authentication:
        "real JWT guard and persisted roles; synthetic provisioning, no password login",
    };
  });
  const records = [];
  await step("real_ingest_body_outbox_response_loss", async () => {
    for (let index = 0; index < 3; index++) {
      const now = new Date().toISOString(),
        r = {
          schemaVersion: 2,
          sourceInstanceId: sourceId,
          sourceSequence: index + 1,
          eventId: randomUUID(),
          recordVersion: 1,
          invocationId: randomUUID(),
          requestId: randomUUID(),
          phase: "finished",
          serverType: "gateway",
          spanKind: "gateway_request",
          protocolTransport: "http",
          origin: "external",
          runtimeAssetId: asset,
          identitySource: "authenticated",
          callerId: "backup-caller",
          startedAt: now,
          completedAt: now,
          outcome: "success",
          statusCode: 200,
          request: captureAuditBody({
            value: "retained-" + index,
            password: "synthetic-sensitive-value",
          }),
          response: captureAuditBody(
            Buffer.from([0, 255, 128, index]),
            "application/octet-stream",
          ),
        };
      assert.equal((await current.store.ingest(r)).status, "inserted");
      records.push(r);
    }
    await current.database
      .getRepository(entities.RuntimePayloadEntity)
      .update(
        { invocationId: records[2].invocationId },
        { expiresAt: new Date(Date.now() - 1000).toISOString() },
      );
    const materialized = await current.outbox.runOnce(256);
    assert.ok(materialized.deliveriesCreated >= 3);
    await current.delivery.runOnce(100);
    const retry = await current.database
      .getRepository(entities.RuntimeEventDeliveryEntity)
      .findBy({ status: "retry_wait" });
    assert.equal(
      retry.length,
      1,
      "one accepted request has deliberately lost response",
    );
    await current.database
      .getRepository(entities.RuntimeEventDeliveryEntity)
      .update(retry[0].id, {
        nextAttemptAt: new Date(Date.now() - 1000).toISOString(),
      });
    const read = await current.request(
      records[0].invocationId,
      users.reader.id,
    );
    assert.equal(read.status, 200);
    assert.equal(read.body.data.content.password, "[REDACTED]");
    fs.mkdirSync(path.join(sourceFiles, "audit-staging"));
    fs.writeFileSync(
      path.join(sourceFiles, "audit-staging", "synthetic-calls-v2.jsonl"),
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    return {
      invocations: records.map((r) => r.invocationId),
      materialized,
      pendingDeliveryId: retry[0].id,
      expiryFixture:
        "explicit past expiresAt for third invocation; owned database only",
    };
  });
  const sourceSnapshot = await dbSnapshot(current),
    sourceWatermark = await current.store.watermark(),
    objectRows = await current.database
      .getRepository(entities.RuntimePayloadEntity)
      .find({ order: { id: "ASC" } }),
    recoverableAt = new Date().toISOString(),
    backupStarted = Date.now();
  let filesManifest,
    unwrapKey = randomBytes(32);
  await step("quiesced_complete_backup", async () => {
    await current.close();
    current = null;
    const active = (
      await admin.query(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname='obs_source' AND pid<>pg_backend_pid()",
      )
    ).rows[0].count;
    assert.equal(
      active,
      0,
      "all fixture connections stopped before cross-store backup",
    );
    await pgRun("pg_dump", [
      "-h",
      "127.0.0.1",
      "-p",
      String(pgPort),
      "-U",
      "obs_backup_fixture",
      "-d",
      "obs_source",
      "-Fc",
      "--no-owner",
      "--no-acl",
      "-f",
      path.join(archive, "database.dump"),
    ]);
    fs.cpSync(sourceFiles, path.join(archive, "files"), {
      recursive: true,
      errorOnExist: true,
    });
    filesManifest = inventory(sourceFiles);
    assert.deepEqual(inventory(path.join(archive, "files")), filesManifest);
    fs.writeFileSync(
      path.join(archive, "configuration.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          settings: publicConfig,
          dataDirectory: "files/data",
          auditStagingDirectory: "files/audit-staging",
          secretRefs: Object.keys(secretConfig),
          secretRestore:
            "separate encrypted vault; independent in-memory unwrap key in fixture",
          quiescence:
            "owned services closed; zero source database connections; no concurrent file writers",
          recoverableAt,
          sourceWatermark,
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(archive, "files-manifest.json"),
      JSON.stringify(filesManifest, null, 2),
    );
    fs.writeFileSync(
      path.join(archive, "tables-manifest.json"),
      JSON.stringify(sourceSnapshot, null, 2),
    );
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", unwrapKey, iv),
      ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(secretConfig)),
        cipher.final(),
      ]);
    fs.writeFileSync(
      path.join(vault, "configuration-secrets.encrypted.json"),
      JSON.stringify({
        algorithm: "aes-256-gcm",
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      }),
      { mode: 0o600 },
    );
    for (const file of inventory(archive))
      for (const secret of secrets)
        assert.equal(
          fs
            .readFileSync(path.join(archive, file.path))
            .includes(Buffer.from(secret)),
          false,
          "ordinary archive excludes secrets",
        );
    return {
      recoverableAt,
      sourceWatermark,
      databaseTables: sourceSnapshot.length,
      fileCount: filesManifest.length,
      fileBytes: filesManifest.reduce((n, f) => n + f.size, 0),
      backupMs: Date.now() - backupStarted,
      dumpSha256: sha(fs.readFileSync(path.join(archive, "database.dump"))),
      sourceConnections: active,
      separateSecretVault: true,
    };
  });
  // Make original storage unavailable so restored services cannot silently fall back to it.
  await admin.query("ALTER DATABASE obs_source WITH ALLOW_CONNECTIONS false");
  fs.renameSync(sourceFiles, sourceFiles + "-offline");
  const restoreStarted = Date.now();
  await step("new_database_directory_and_secret_restore", async () => {
    const { Client } = require("pg"),
      blank = new Client({
        host: "127.0.0.1",
        port: pgPort,
        user: "obs_backup_fixture",
        database: "obs_restored",
      });
    await blank.connect();
    const count = (
      await blank.query(
        "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'",
      )
    ).rows[0].n;
    await blank.end();
    assert.equal(count, 0);
    assert.equal(fs.existsSync(targetFiles), false);
    await pgRun("pg_restore", [
      "-h",
      "127.0.0.1",
      "-p",
      String(pgPort),
      "-U",
      "obs_backup_fixture",
      "-d",
      "obs_restored",
      "--no-owner",
      "--no-acl",
      "--exit-on-error",
      path.join(archive, "database.dump"),
    ]);
    fs.cpSync(path.join(archive, "files"), targetFiles, {
      recursive: true,
      errorOnExist: true,
    });
    assert.deepEqual(inventory(targetFiles), filesManifest);
    const config = JSON.parse(
        fs.readFileSync(path.join(archive, "configuration.json"), "utf8"),
      ),
      sealed = JSON.parse(
        fs.readFileSync(
          path.join(vault, "configuration-secrets.encrypted.json"),
          "utf8",
        ),
      ),
      decipher = createDecipheriv(
        "aes-256-gcm",
        unwrapKey,
        Buffer.from(sealed.iv, "base64"),
      );
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    const restoredSecrets = JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(sealed.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8"),
    );
    unwrapKey.fill(0);
    unwrapKey = null;
    assert.deepEqual(
      Object.keys(restoredSecrets).sort(),
      config.secretRefs.sort(),
    );
    current = await open("obs_restored", targetFiles, {
      ...config.settings,
      ...restoredSecrets,
    });
    assert.deepEqual(
      await dbSnapshot(current),
      sourceSnapshot,
      "all migrated table row fingerprints before requests/workers",
    );
    assert.equal(await current.store.watermark(), sourceWatermark);
    return {
      cleanTargetTablesBefore: count,
      allTablesIdentical: true,
      fileHashesIdentical: true,
      sourceAndTargetPathsDiffer: true,
      milliseconds: Date.now() - restoreStarted,
    };
  });
  await step("restored_body_integrity_authorization_expiry", async () => {
    const rows = await current.database
      .getRepository(entities.RuntimePayloadEntity)
      .find({ order: { id: "ASC" } });
    assert.deepEqual(rows, objectRows);
    for (const object of rows.filter((o) => o.fileKey)) {
      const b = fs.readFileSync(
        path.join(targetFiles, "data/payloads", object.fileKey),
      );
      assert.equal(sha(b), object.digest);
    }
    const id = records[0].invocationId,
      read = await current.request(id, users.reader.id);
    assert.equal(read.status, 200);
    assert.equal(read.cache, "no-store");
    assert.deepEqual(read.body.data.content, {
      value: "retained-0",
      password: "[REDACTED]",
    });
    const binary = await current.request(id, users.reader.id, "response");
    assert.equal(binary.status, 200);
    assert.deepEqual(
      Buffer.from(binary.body.data.content, "base64"),
      Buffer.from([0, 255, 128, 0]),
    );
    assert.equal((await current.request(id, null)).status, 401);
    assert.equal((await current.request(id, users.denied.id)).status, 403);
    assert.equal((await current.request(id, users.otherAsset.id)).status, 404);
    const expired = await current.request(
      records[2].invocationId,
      users.reader.id,
    );
    assert.equal(expired.status, 410);
    assert.equal(expired.body.error.details.state, "expired");
    assert.ok(
      (await current.database.getRepository(AuditLog).find()).some(
        (r) => r.details?.result === "prepared",
      ),
    );
    return {
      payloadReferences: rows.length,
      cases: [
        "JSON redacted 200",
        "binary exact bytes 200",
        "anonymous 401",
        "missing permission 403",
        "out-of-scope 404",
        "expired 410",
      ],
      mandatoryAuditPresent: true,
    };
  });
  await step("ordinary_event_delivery_receiver_deduplication", async () => {
    const deliveries = current.database.getRepository(
        entities.RuntimeEventDeliveryEntity,
      ),
      before = await deliveries.count(),
      outbox = await current.outbox.runOnce(256);
    assert.equal(outbox.deliveriesCreated, 0);
    const report = await current.delivery.runOnce(100);
    assert.equal(report.succeeded, 1);
    assert.equal(await deliveries.count(), before);
    assert.equal(await deliveries.countBy({ status: "succeeded" }), before);
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
    assert.equal(Object.keys(ledger).length, before);
    assert.equal(
      Object.values(ledger).filter((r) => r.receipts === 2).length,
      1,
    );
    assert.ok(Object.values(ledger).every((r) => r.sideEffects === 1));
    assert.equal((await current.delivery.runOnce(100)).succeeded, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(ledgerFile, "utf8")), ledger);
    assert.ok(
      (await current.database.getRepository(EventEntity).find()).some(
        (e) =>
          e.subjectId === records[0].invocationId &&
          e.eventName !== "subscription.test",
      ),
    );
    return {
      deliveries: before,
      duplicatedPhysicalReceipts: 1,
      businessSideEffects: before,
      repeatRunNoDelivery: true,
      receiverLedgerRestoredFromApplicationBackup: false,
      workerReport: report,
    };
  });
  evidence.measurement = {
    recoverableAt,
    sourceWatermark,
    rtoMeasuredMs: Date.now() - restoreStarted,
    rtoDefinition:
      "pg_restore start through HTTP authorization and delivery convergence",
    lossWithinQuiescedSnapshot: 0,
    rpoDefinition:
      "known fixture rows/files identical at quiescence; no online-write loss window simulated",
    sla: "not asserted",
  };
  evidence.artifacts = [
    __filename,
    path.join(root, "package-lock.json"),
    path.join(
      api,
      "dist/src/modules/call-observability/call-observability.store.js",
    ),
    path.join(
      api,
      "dist/src/modules/call-observability/call-observability-delivery.worker.js",
    ),
  ].map((file) => ({
    path: path.relative(root, file),
    sha256: sha(fs.readFileSync(file)),
  }));
  evidence.marker = "OBS_16_04_BACKUP_RESTORE_OK";
}
main()
  .catch((error) => {
    evidence.marker = "OBS_16_04_BACKUP_RESTORE_FAILED";
    evidence.failure = redact(error.stack || error);
    console.error(evidence.failure);
    process.exitCode = 1;
  })
  .finally(async () => {
    const cleanup = {};
    try {
      if (current) await current.close();
      cleanup.servicesStopped = true;
    } catch (e) {
      cleanup.servicesError = e.message;
      process.exitCode = 1;
    }
    try {
      if (receiver)
        await new Promise((r) => {
          receiver.closeAllConnections();
          receiver.close(r);
        });
      cleanup.receiverStopped = true;
    } catch (e) {
      cleanup.receiverError = e.message;
      process.exitCode = 1;
    }
    for (const app of openedApps) await app.close().catch(() => {});
    for (const payloads of openedPayloads)
      await payloads.onModuleDestroy().catch(() => {});
    for (const db of openedDatabases)
      if (db.isInitialized) await db.destroy().catch(() => {});
    try {
      if (admin) await admin.end();
      if (pgStarted)
        await pgRun("pg_ctl", [
          "-D",
          pgdata,
          "-m",
          "fast",
          "-w",
          "-t",
          "30",
          "stop",
        ]);
      cleanup.postgresStopped = true;
    } catch (e) {
      cleanup.postgresError = e.message;
      process.exitCode = 1;
    }
    evidence.cleanup = cleanup;
    evidence.finishedAt = new Date().toISOString();
    if (process.exitCode) evidence.marker = "OBS_16_04_BACKUP_RESTORE_FAILED";
    save();
    console.log(
      evidence.marker +
        " " +
        JSON.stringify({
          directory,
          passed: evidence.steps.filter((s) => s.passed).length,
          measurement: evidence.measurement,
          cleanup,
        }),
    );
  });
