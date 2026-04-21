export default {
  servers: {
    runtimeAssetsActions: {
      deployRuntime: "Deploy Runtime",
    },
    messages: {
      startSuccess: 'Server "{name}" started successfully',
      startError: "Failed to start server: {error}",
      confirmStop: 'Stop server "{name}"?',
      stopSuccess: 'Server "{name}" stopped successfully',
      stopError: "Failed to stop server: {error}",
      confirmRestart: 'Restart server "{name}"?',
      restartSuccess: 'Server "{name}" restarted successfully',
      restartError: "Failed to restart server: {error}",
      confirmStopAndDelete:
        'Server "{name}" is running. Stop it and continue deleting?',
      serverRunning: "The server is currently running.",
      stopAndDelete: "Stop and Delete",
      deleteSuccess: 'Server "{name}" deleted successfully',
      deleteError: "Failed to delete server: {error}",
    },
  },
  monitoring: {
    runtimeAssets: {
      actions: {
        deploy: "Deploy",
        deploySuccess: 'Runtime asset "{name}" deployed',
        deployFailed: "Failed to deploy runtime asset",
      },
    },
  },
  endpointRegistry: {
    operationFeed: {
      collapse: "Collapse",
      expand: "Expand",
    },
    testDialog: {
      title: "Endpoint Test",
      testStatus: "Test Status",
      httpStatus: "HTTP Status",
      lastTestAt: "Last Test At",
      parameters: "Parameters",
      parametersPlaceholder:
        "Enter JSON object parameters for this endpoint test, for example {\"id\": 1}",
      result: "Test Result",
      loadFailed: "Failed to load endpoint test context",
      executeFailed: "Endpoint test failed",
      parametersObjectRequired: "Test parameters must be a JSON object",
    },
  },
};
