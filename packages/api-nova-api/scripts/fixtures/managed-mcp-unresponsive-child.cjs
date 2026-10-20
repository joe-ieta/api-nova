'use strict';
// Isolated test process: accept the real wire envelope, deliberately never send
// READY and ignore STOP. Production always resolves its fixed managed/entry.js;
// only the test-local module loader can substitute this file.
const { parseManagedParentMessage } = require('api-nova-server');
setInterval(() => {}, 1000);
process.on('message', input => {
  const message = parseManagedParentMessage(input);
  if (message.type === 'handoff') {
    process.send({ type: 'handoffAccepted', launchId: message.launchId });
  } else if (message.type === 'stop') {
    process.stdout.write('NP20_STOP_IGNORED\n');
  }
});
