import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiBearerAuth,
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
}

