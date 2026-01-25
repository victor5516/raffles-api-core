import { Controller, Get, Query, Param } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';
import { AdminAuth } from '../auth/decorators/admin-auth.decorator';

@ApiTags('Dashboard')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('overview')
  @AdminAuth()
  @ApiOperation({ summary: 'Obtener resumen general del dashboard' })
  @ApiBearerAuth('JWT-auth')
  @ApiQuery({
    name: 'currencyId',
    description: 'UID de la divisa para filtrar (opcional)',
    example: '123e4567-e89b-12d3-a456-426614174000',
    required: false,
  })
  @ApiResponse({
    status: 200,
    description: 'Resumen del dashboard obtenido exitosamente',
  })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  getOverview(@Query('currencyId') currencyId?: string) {
    return this.dashboardService.getOverview(currencyId);
  }

  @Get('top-customers/:raffleId')
  @AdminAuth()
  @ApiOperation({ summary: 'Obtener top clientes por rifa' })
  @ApiBearerAuth('JWT-auth')
  @ApiParam({
    name: 'raffleId',
    description: 'UID de la rifa',
    type: String,
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 200,
    description: 'Top clientes obtenido exitosamente',
  })
  getTopCustomers(@Param('raffleId') raffleId: string) {
    return this.dashboardService.getTopCustomers(raffleId);
  }
}

