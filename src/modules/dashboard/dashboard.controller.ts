import { Controller, Get, Query } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { AdminAuth } from '../auth/decorators/admin-auth.decorator';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('overview')
  @AdminAuth()
  getOverview(@Query('currencyId') currencyId?: string) {
    return this.dashboardService.getOverview(currencyId);
  }
}

