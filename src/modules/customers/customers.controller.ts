import {
  Controller,
  Get,
  Patch,
  Param,
  Query,
  Body,
  Res,
  Post,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiQuery,
  ApiBearerAuth,
  ApiProduces,
} from '@nestjs/swagger';
import { Response } from 'express';
import { CustomersService } from './customers.service';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { ToggleBlacklistDto } from './dto/toggle-blacklist.dto';
import { MergeCustomersDto } from './dto/merge-customers.dto';
import { Auth } from '../auth/decorators/admin-auth.decorator';
import { ActiveUser } from '../auth/decorators/active-user.decorator';
import { Admin } from '../auth/entities/admin.entity';
import { AdminRole } from '../auth/enums/admin-role.enum';

@ApiTags('Customers')
@Controller('customers')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get()
  @Auth([
    AdminRole.SUPER_ADMIN,
    AdminRole.VERIFIER,
    AdminRole.VERIFIER_EXPORT,
    AdminRole.VERIFIER_STATS,
  ])
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Obtener lista de clientes con filtros opcionales',
    description: 'Requiere autenticación de administrador.',
  })
  @ApiQuery({
    name: 'nationalId',
    required: false,
    description: 'Filtrar por número de cédula',
    type: String,
  })
  @ApiQuery({
    name: 'phone',
    required: false,
    description: 'Filtrar por teléfono',
    type: String,
  })
  @ApiQuery({
    name: 'fullName',
    required: false,
    description: 'Filtrar por nombre completo',
    type: String,
  })
  @ApiQuery({
    name: 'page',
    required: false,
    description: 'Número de página',
    type: Number,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Cantidad de resultados por página',
    type: Number,
  })
  @ApiQuery({
    name: 'isBlacklisted',
    required: false,
    description: 'Filtrar por estado de bloqueo (true/false)',
    type: String,
  })
  @ApiResponse({
    status: 200,
    description: 'Lista de clientes obtenida exitosamente',
  })
  findAll(@Query() query: Record<string, unknown>) {
    return this.customersService.findAll(query);
  }

  @Get('export/excel')
  @Auth([AdminRole.VERIFIER_EXPORT, AdminRole.SUPER_ADMIN])
  @ApiOperation({ summary: 'Exportar clientes a Excel' })
  @ApiBearerAuth('JWT-auth')
  @ApiProduces(
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  @ApiResponse({
    status: 200,
    description: 'Archivo Excel de clientes generado exitosamente',
    content: {
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
        schema: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  @ApiResponse({ status: 403, description: 'Permisos insuficientes' })
  async exportCustomers(
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    const buffer = await this.customersService.exportCustomersExcel(query);
    const timestamp = new Date().toISOString().slice(0, 10);
    const filename = `clientes-${timestamp}.xlsx`;

    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length,
    });

    res.send(buffer);
  }

  @Get(':uid')
  @Auth([
    AdminRole.SUPER_ADMIN,
    AdminRole.VERIFIER,
    AdminRole.VERIFIER_EXPORT,
    AdminRole.VERIFIER_STATS,
  ])
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Obtener un cliente por su UID con rifas y tickets asociados',
    description: 'Requiere autenticación de administrador.',
  })
  @ApiParam({
    name: 'uid',
    description: 'UID del cliente',
    type: String,
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 200,
    description: 'Cliente encontrado con sus rifas y tickets',
  })
  @ApiResponse({ status: 404, description: 'Cliente no encontrado' })
  findOne(@Param('uid') uid: string) {
    return this.customersService.findOne(uid);
  }

  @Patch(':uid')
  @Auth([
    AdminRole.SUPER_ADMIN,
    AdminRole.VERIFIER,
    AdminRole.VERIFIER_EXPORT,
    AdminRole.VERIFIER_STATS,
  ])
  @ApiOperation({ summary: 'Actualizar información de un cliente' })
  @ApiBearerAuth('JWT-auth')
  @ApiParam({
    name: 'uid',
    description: 'UID del cliente a actualizar',
    type: String,
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 200,
    description: 'Cliente actualizado exitosamente',
  })
  @ApiResponse({ status: 400, description: 'Datos inválidos' })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  @ApiResponse({ status: 403, description: 'Permisos insuficientes' })
  @ApiResponse({ status: 404, description: 'Cliente no encontrado' })
  @ApiResponse({ status: 409, description: 'El email ya está en uso' })
  update(
    @Param('uid') uid: string,
    @Body() updateDto: UpdateCustomerDto,
    @ActiveUser() admin: Admin,
  ) {
    return this.customersService.update(uid, updateDto, admin.uid);
  }

  @Patch(':uid/blacklist')
  @Auth([AdminRole.SUPER_ADMIN])
  @ApiOperation({ summary: 'Bloquear o desbloquear un cliente' })
  @ApiBearerAuth('JWT-auth')
  @ApiParam({
    name: 'uid',
    description: 'UID del cliente',
    type: String,
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 200,
    description: 'Estado de blacklist actualizado exitosamente',
  })
  @ApiResponse({ status: 400, description: 'Datos inválidos' })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  @ApiResponse({
    status: 403,
    description: 'Solo Super Admin puede gestionar la blacklist',
  })
  @ApiResponse({ status: 404, description: 'Cliente no encontrado' })
  toggleBlacklist(
    @Param('uid') uid: string,
    @Body() dto: ToggleBlacklistDto,
    @ActiveUser() admin: Admin,
  ) {
    return this.customersService.toggleBlacklist(uid, dto, admin.uid);
  }

  @Post(':uid/merge')
  @Auth([AdminRole.SUPER_ADMIN])
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary:
      'Fusionar dos clientes (mover compras al destino y eliminar el origen)',
  })
  @ApiParam({
    name: 'uid',
    description: 'UID del cliente origen (el que desaparece)',
    type: String,
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({ status: 200, description: 'Clientes fusionados exitosamente' })
  @ApiResponse({
    status: 400,
    description: 'sourceId y targetId no pueden ser iguales',
  })
  @ApiResponse({
    status: 403,
    description: 'Solo Super Admin puede fusionar clientes',
  })
  @ApiResponse({
    status: 404,
    description: 'Uno o ambos clientes no encontrados',
  })
  mergeCustomers(
    @Param('uid') uid: string,
    @Body() dto: MergeCustomersDto,
    @ActiveUser() admin: Admin,
  ) {
    return this.customersService.mergeCustomers(
      uid,
      dto.targetCustomerId,
      admin.uid,
    );
  }
}
