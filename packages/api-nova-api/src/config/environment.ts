import { ConfigModule } from '@nestjs/config';
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { validationSchema } from './validation.schema';

function findPackageRoot(): string {
  let directory = __dirname;
  while (!existsSync(join(directory, 'package.json'))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error('API package root was not found');
    directory = parent;
  }
  return directory;
}

export const apiPackageRoot = findPackageRoot();
const environment = process.env.NODE_ENV || 'development';
const explicitFile = process.env.API_NOVA_ENV_FILE;
if (explicitFile && !existsSync(resolve(explicitFile))) {
  throw new Error('API_NOVA_ENV_FILE does not exist');
}

// Load before importing entities: their column types depend on DB_TYPE.
export const applicationConfigModule = ConfigModule.forRoot({
  isGlobal: true,
  ignoreEnvFile: environment === 'test' && !explicitFile,
  envFilePath: explicitFile
    ? resolve(explicitFile)
    : [
        join(apiPackageRoot, '.env.local'),
        join(apiPackageRoot, `.env.${environment}`),
        join(apiPackageRoot, '.env'),
      ],
  validationSchema,
  validationOptions: { allowUnknown: true, abortEarly: false },
  expandVariables: true,
});
