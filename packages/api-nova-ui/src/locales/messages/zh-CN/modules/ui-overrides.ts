export default {
  servers: {
    runtimeAssetsActions: {
      deployRuntime: "部署运行时",
    },
    messages: {
      startSuccess: '服务“{name}”启动成功',
      startError: "启动服务失败：{error}",
      confirmStop: '确定停止服务“{name}”吗？',
      stopSuccess: '服务“{name}”停止成功',
      stopError: "停止服务失败：{error}",
      confirmRestart: '确定重启服务“{name}”吗？',
      restartSuccess: '服务“{name}”重启成功',
      restartError: "重启服务失败：{error}",
      confirmStopAndDelete: '服务“{name}”仍在运行，是否先停止再删除？',
      serverRunning: "该服务当前仍在运行。",
      stopAndDelete: "停止并删除",
      deleteSuccess: '服务“{name}”删除成功',
      deleteError: "删除服务失败：{error}",
    },
  },
  monitoring: {
    runtimeAssets: {
      actions: {
        deploy: "部署",
        deploySuccess: '运行时资产“{name}”已完成部署',
        deployFailed: "部署运行时资产失败",
      },
    },
  },
  endpointRegistry: {
    operationFeed: {
      collapse: "收起",
      expand: "展开",
    },
    testDialog: {
      title: "Endpoint 测试",
      testStatus: "测试状态",
      httpStatus: "HTTP 状态码",
      lastTestAt: "最近测试时间",
      parameters: "测试参数",
      parametersPlaceholder:
        "请输入用于该 Endpoint 测试的 JSON 对象，例如 {\"id\": 1}",
      result: "测试结果",
      loadFailed: "加载 Endpoint 测试上下文失败",
      executeFailed: "Endpoint 测试失败",
      parametersObjectRequired: "测试参数必须是 JSON 对象",
    },
  },
};
