import { Injectable, Logger } from '@nestjs/common';
import { load } from 'js-yaml';
import {
  validate,
  ValidationError,
  ValidationWarning,
} from 'api-nova-parser';

// Management API validation response.
export interface SpecificationValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

@Injectable()
export class ValidatorService {
  private readonly logger = new Logger(ValidatorService.name);

  private sanitizeSpecification(spec: any): any {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      return spec;
    }

    const sanitized = { ...spec };
    delete sanitized.metadata;
    delete sanitized.tools;
    delete sanitized.endpoints;
    delete sanitized.parsedAt;
    delete sanitized.parseId;
    delete sanitized._metadata;

    return sanitized;
  }

  private parseSpecificationString(content: string): any {
    const trimmed = content.trim();

    if (!trimmed) {
      throw new Error('OpenAPI content cannot be empty');
    }

    try {
      return JSON.parse(trimmed);
    } catch {
      return load(trimmed);
    }
  }

  async validateSpecification(spec: any): Promise<SpecificationValidationResult> {
    try {
      this.logger.log('Starting OpenAPI specification validation');

      const parsedSpec =
        typeof spec === 'string' ? this.parseSpecificationString(spec) : spec;
      const sanitizedSpec = this.sanitizeSpecification(parsedSpec);
      const validationResult = await validate(sanitizedSpec, {
        strictMode: false,
        resolveReferences: true,
        validateSchema: true
      });

      this.logger.log(`OpenAPI validation completed: ${validationResult.valid ? 'valid' : 'invalid'} with ${validationResult.errors.length} errors and ${validationResult.warnings.length} warnings`);

      // Map parser diagnostics to the management API response.
      return {
        valid: validationResult.valid,
        errors: validationResult.errors.map((err: ValidationError) => err.message),
        warnings: validationResult.warnings.map((warn: ValidationWarning) => warn.message)
      };
    } catch (error) {
      this.logger.error(`Error during OpenAPI validation: ${error.message}`, error.stack);
      return {
        valid: false,
        errors: [`Validation error: ${error.message}`],
        warnings: []
      };
    }
  }

}
