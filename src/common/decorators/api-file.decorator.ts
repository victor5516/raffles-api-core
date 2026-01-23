import { applyDecorators } from '@nestjs/common';
import { ApiConsumes } from '@nestjs/swagger';

/**
 * Decorator to mark an endpoint as consuming multipart/form-data
 * and to document file upload fields in Swagger.
 *
 * Note: This decorator should be used alongside @ApiBody() with the DTO type.
 * The file field will be documented separately in Swagger UI.
 *
 * @param fieldName - Name of the file field in the form data
 * @param required - Whether the file is required
 */
export function ApiFile(fieldName: string = 'file', required: boolean = false) {
  return applyDecorators(
    ApiConsumes('multipart/form-data'),
  );
}
