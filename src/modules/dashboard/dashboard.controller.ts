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
import { AdminAuth, Auth } from '../auth/decorators/admin-auth.decorator';
import { AdminRole } from '../auth/enums/admin-role.enum';
import { RaffleStatsResponseDto } from './dto/raffle-stats-response.dto';
import { ActiveUser } from '../auth/decorators/active-user.decorator';
import { Admin } from '../auth/entities/admin.entity';

@ApiTags('Dashboard')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('overview')
  @AdminAuth()
  @ApiOperation({
    summary: 'Obtener resumen general del dashboard',
    description: 'Solo SUPER_ADMIN recibe metrics.revenue.',
  })
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
  async getOverview(
    @Query('currencyId') currencyId: string | undefined,
    @ActiveUser() admin: Admin,
  ) {
    const overview = await this.dashboardService.getOverview(currencyId);

    if (admin.role === AdminRole.SUPER_ADMIN) {
      return overview;
    }

    const { revenue: _revenue, ...restMetrics } = overview.metrics;
    return {
      ...overview,
      metrics: restMetrics,
    };
  }

  @Get('top-customers/:raffleId')
  @ApiOperation({ summary: 'Obtener top compradores por rifa (público)' })
  @ApiParam({
    name: 'raffleId',
    description: 'UID de la rifa',
    type: String,
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 200,
    description: 'Top compradores obtenido exitosamente',
  })
  getTopCustomers(@Param('raffleId') raffleId: string) {
    return this.dashboardService.getTopCustomers(raffleId);
  }

  @Get('admin/top-customers/:raffleId')
  @Auth([
    AdminRole.SUPER_ADMIN,
    AdminRole.VERIFIER,
    AdminRole.VERIFIER_EXPORT,
    AdminRole.VERIFIER_STATS,
  ])
  @ApiOperation({
    summary: 'Obtener top compradores por rifa (admin protegido, sin auditor)',
  })
  @ApiBearerAuth('JWT-auth')
  @ApiParam({
    name: 'raffleId',
    description: 'UID de la rifa',
    type: String,
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 200,
    description: 'Top compradores obtenido exitosamente',
  })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  @ApiResponse({
    status: 403,
    description: 'Permisos insuficientes para consultar top compradores',
  })
  getTopCustomersAdmin(@Param('raffleId') raffleId: string) {
    return this.dashboardService.getTopCustomers(raffleId);
  }

  @Get('raffles/:raffleId/stats')
  @Auth([AdminRole.SUPER_ADMIN, AdminRole.VERIFIER_STATS])
  @ApiOperation({ summary: 'Obtener estadísticas del dashboard por rifa' })
  @ApiBearerAuth('JWT-auth')
  @ApiParam({
    name: 'raffleId',
    description: 'UID de la rifa',
    type: String,
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 200,
    description: 'Estadísticas por rifa obtenidas exitosamente',
    type: RaffleStatsResponseDto,
  })
  @ApiResponse({ status: 401, description: 'No autorizado' })
  @ApiResponse({ status: 403, description: 'Permisos insuficientes' })
  @ApiResponse({ status: 404, description: 'Rifa no encontrada' })
  getRaffleStats(
    @Param('raffleId') raffleId: string,
  ): Promise<RaffleStatsResponseDto> {
    return this.dashboardService.getRaffleStats(raffleId);
  }
}
