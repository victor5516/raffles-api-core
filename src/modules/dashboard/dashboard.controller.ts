import { Controller, Get } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { AdminAuth } from '../auth/decorators/admin-auth.decorator';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('overview')
  @AdminAuth()
  getOverview() {
    return this.dashboardService.getOverview();
  }
}

