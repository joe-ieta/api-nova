import chalk from 'chalk';
import type { OperationFilter } from 'api-nova-parser';
import { validateOperationFilter, normalizeOperationFilter } from '../utils/validation';
import { ServerOptions, ConfigFile } from './types';

function deepMergeFilterField<T extends { include?: string[]; exclude?: string[] }>(
  base: T | undefined,
  override: T | undefined
): T | undefined {
  if (!override) return base;
  if (!base) return override;
  
  return {
    ...base,
    ...override,
    include: override.include || base.include,
    exclude: override.exclude || base.exclude,
  } as T;
}

function deepMergeParameterField(
  base: { required?: string[]; forbidden?: string[] } | undefined,
  override: { required?: string[]; forbidden?: string[] } | undefined
): { required?: string[]; forbidden?: string[] } | undefined {
  if (!override) return base;
  if (!base) return override;
  
  return {
    required: override.required || base.required,
    forbidden: override.forbidden || base.forbidden,
  };
}

export function parseOperationFilter(
  options: ServerOptions & { 
    'operation-filter-methods'?: string[], 
    'operation-filter-paths'?: string[], 
    'operation-filter-operation-ids'?: string[], 
    'operation-filter-status-codes'?: string[], 
    'operation-filter-parameters'?: string[] 
  },
  config?: ConfigFile
): OperationFilter | undefined {
  const filter: OperationFilter = {};
  let hasConfig = false;

  if (config?.operationFilter) {
    const normalizedConfigFilter = normalizeOperationFilter(config.operationFilter);
    if (normalizedConfigFilter) {
      Object.assign(filter, normalizedConfigFilter);
      hasConfig = true;
    }
  }

  if (options['operation-filter-methods']) {
    const cliMethods = { include: options['operation-filter-methods'] };
    filter.methods = deepMergeFilterField(filter.methods, cliMethods);
    hasConfig = true;
  }

  if (options['operation-filter-paths']) {
    const cliPaths = { include: options['operation-filter-paths'] };
    filter.paths = deepMergeFilterField(filter.paths, cliPaths);
    hasConfig = true;
  }

  if (options['operation-filter-operation-ids']) {
    const cliOperationIds = { include: options['operation-filter-operation-ids'] };
    filter.operationIds = deepMergeFilterField(filter.operationIds, cliOperationIds);
    hasConfig = true;
  }

  if (options['operation-filter-status-codes']) {
    const parsedCodes = options['operation-filter-status-codes']
      .map(code => Number(code));
    const cliStatusCodes = { include: parsedCodes };
    filter.statusCodes = deepMergeFilterField(filter.statusCodes as any, cliStatusCodes as any);
    hasConfig = true;
  }

  if (options['operation-filter-parameters']) {
    const cliParams = { required: options['operation-filter-parameters'] };
    filter.parameters = deepMergeParameterField(filter.parameters, cliParams);
    hasConfig = true;
  }

  if (!hasConfig) {
    return undefined;
  }

  const validationResult = validateOperationFilter(filter);
  
  if (!validationResult.valid) {
    console.error(chalk.red('❌ Operation filter configuration validation failed:'));
    validationResult.errors.forEach(error => {
      console.error(chalk.red(`   • ${error}`));
    });
    process.exit(1);
  }

  if (validationResult.warnings.length > 0) {
    console.warn(chalk.yellow('⚠️  Operation filter configuration warnings:'));
    validationResult.warnings.forEach(warning => {
      console.warn(chalk.yellow(`   • ${warning}`));
    });
  }

  const normalizedFilter = normalizeOperationFilter(filter);
  
  if (normalizedFilter && Object.keys(normalizedFilter).length > 0) {
    console.log(chalk.green('✅ Operation filter configuration loaded successfully'));
    
    if (normalizedFilter.methods) {
      const methods = [];
      if (normalizedFilter.methods.include) methods.push(`include: ${normalizedFilter.methods.include.join(', ')}`);
      if (normalizedFilter.methods.exclude) methods.push(`exclude: ${normalizedFilter.methods.exclude.join(', ')}`);
      if (methods.length > 0) {
        console.log(chalk.blue(`   Methods: ${methods.join('; ')}`));
      }
    }
    if (normalizedFilter.paths) {
      const paths = [];
      if (normalizedFilter.paths.include) paths.push(`include: ${normalizedFilter.paths.include.length} path(s)`);
      if (normalizedFilter.paths.exclude) paths.push(`exclude: ${normalizedFilter.paths.exclude.length} path(s)`);
      if (paths.length > 0) {
        console.log(chalk.blue(`   Paths: ${paths.join('; ')}`));
      }
    }
    if (normalizedFilter.operationIds) {
      const operationIds = [];
      if (normalizedFilter.operationIds.include) operationIds.push(`include: ${normalizedFilter.operationIds.include.length} ID(s)`);
      if (normalizedFilter.operationIds.exclude) operationIds.push(`exclude: ${normalizedFilter.operationIds.exclude.length} ID(s)`);
      if (operationIds.length > 0) {
        console.log(chalk.blue(`   Operation IDs: ${operationIds.join('; ')}`));
      }
    }
    if (normalizedFilter.statusCodes) {
      const statusCodes = [];
      if (normalizedFilter.statusCodes.include) statusCodes.push(`include: ${normalizedFilter.statusCodes.include.join(', ')}`);
      if (normalizedFilter.statusCodes.exclude) statusCodes.push(`exclude: ${normalizedFilter.statusCodes.exclude.join(', ')}`);
      if (statusCodes.length > 0) {
        console.log(chalk.blue(`   Status Codes: ${statusCodes.join('; ')}`));
      }
    }
    if (normalizedFilter.parameters) {
      const parameters = [];
      if (normalizedFilter.parameters.required) parameters.push(`required: ${normalizedFilter.parameters.required.length} parameter(s)`);
      if (normalizedFilter.parameters.forbidden) parameters.push(`forbidden: ${normalizedFilter.parameters.forbidden.length} parameter(s)`);
      if (parameters.length > 0) {
        console.log(chalk.blue(`   Parameters: ${parameters.join('; ')}`));
      }
    }
    if (normalizedFilter.customFilter) {
      console.log(chalk.blue('   Custom Filter: enabled'));
    }
  }

  return normalizedFilter;
}
