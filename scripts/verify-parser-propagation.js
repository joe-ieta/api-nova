const { spawnSync } = require('child_process');

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const allSteps = [
  {
    id: 'parser-build',
    label: 'Build parser',
    workspace: 'api-nova-parser',
    script: 'build',
  },
  {
    id: 'server-build',
    label: 'Build server',
    workspace: 'api-nova-server',
    script: 'build',
  },
  {
    id: 'parser-typecheck',
    label: 'Type-check parser',
    workspace: 'api-nova-parser',
    script: 'type-check',
  },
  {
    id: 'server-typecheck',
    label: 'Type-check server',
    workspace: 'api-nova-server',
    script: 'type-check',
  },
  {
    id: 'api-typecheck',
    label: 'Type-check api',
    workspace: 'api-nova-api',
    script: 'type-check',
  },
  {
    id: 'ui-typecheck',
    label: 'Type-check ui',
    workspace: 'api-nova-ui',
    script: 'type-check',
  },
  {
    id: 'api-build',
    label: 'Build api',
    workspace: 'api-nova-api',
    script: 'build',
  },
  {
    id: 'ui-build',
    label: 'Build ui',
    workspace: 'api-nova-ui',
    script: 'build',
  },
];

function parseOptions(argv) {
  const options = {
    buildOnly: false,
    skipUi: false,
    includeConsumerBuilds: false,
  };

  for (const arg of argv) {
    if (arg === '--build-only') {
      options.buildOnly = true;
    } else if (arg === '--skip-ui') {
      options.skipUi = true;
    } else if (arg === '--include-consumer-builds') {
      options.includeConsumerBuilds = true;
    }
  }

  return options;
}

function selectSteps(options) {
  return allSteps.filter((step) => {
    if (options.buildOnly && step.id.includes('typecheck')) {
      return false;
    }
    if (!options.includeConsumerBuilds && (step.id === 'api-build' || step.id === 'ui-build')) {
      return false;
    }
    if (options.skipUi && step.id.startsWith('ui-')) {
      return false;
    }
    return true;
  });
}

function runStep(step) {
  const args = ['run', step.script, '--workspace', step.workspace];
  console.log(`\n[parser-chain] ${step.label}`);
  console.log(`[parser-chain] ${npmCommand} ${args.join(' ')}`);

  const result = spawnSync(npmCommand, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${step.label} failed with exit code ${result.status}`);
  }
}

function main() {
  const options = parseOptions(process.argv.slice(2));
  const steps = selectSteps(options);

  console.log('[parser-chain] Starting parser propagation verification');
  console.log(`[parser-chain] Mode: ${options.buildOnly ? 'build-only' : 'build-and-typecheck'}`);
  console.log(`[parser-chain] UI: ${options.skipUi ? 'skipped' : 'included'}`);
  console.log(`[parser-chain] Consumer builds: ${options.includeConsumerBuilds ? 'included' : 'skipped'}`);

  for (const step of steps) {
    runStep(step);
  }

  console.log('\n[parser-chain] Parser propagation verification completed successfully');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`\n[parser-chain] ${error.message}`);
    process.exit(1);
  }
}
