import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { NotFoundException } from '@nestjs/common';
import { CouponsService } from './coupons.service';
import { GenerateCouponsDto } from './dto/generate-coupons.dto';
import { FilterCouponsDto } from './dto/filter-coupons.dto';
import { UpdateCouponDto } from './dto/update-coupon.dto';
import { Auth } from '../auth/decorators/admin-auth.decorator';
import { ActiveUser } from '../auth/decorators/active-user.decorator';
import { AdminRole } from '../auth/enums/admin-role.enum';
import { Admin } from '../auth/entities/admin.entity';

@ApiTags('Coupons')
@Controller('coupons')
export class CouponsController {
  constructor(private readonly couponsService: CouponsService) {}

  @Post('generate')
  @Auth(AdminRole.SUPER_ADMIN)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Generate a batch of coupons' })
  generate(
    @Body() dto: GenerateCouponsDto,
    @ActiveUser() admin: Admin,
  ): Promise<string[]> {
    return this.couponsService.generateBatch(dto, admin);
  }

  @Get('validate/:code')
  @ApiOperation({ summary: 'Validate a coupon code (public)' })
  async validate(@Param('code') code: string) {
    try {
      const coupon = await this.couponsService.findOne(code);
      if (!coupon.isRedeemable) {
        const reason = !coupon.isActive
          ? 'inactive'
          : coupon.redeemedAt !== null
            ? 'redeemed'
            : 'expired';
        return { code, isValid: false, reason };
      }
      return { code, isValid: true, expiresAt: coupon.expiresAt };
    } catch (err) {
      if (err instanceof NotFoundException) {
        return { code, isValid: false, reason: 'not_found' };
      }
      throw err;
    }
  }

  @Get()
  @Auth()
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'List coupons with filters' })
  findAll(@Query() dto: FilterCouponsDto) {
    return this.couponsService.findAll(dto);
  }

  @Get('stats')
  @Auth()
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get coupon counts by status' })
  getStats() {
    return this.couponsService.getStats();
  }

  @Get(':code')
  @Auth()
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get coupon by code' })
  findOne(@Param('code') code: string) {
    return this.couponsService.findOne(code);
  }

  @Patch(':code')
  @Auth(AdminRole.SUPER_ADMIN)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Update coupon (activate/deactivate, extend expiry)',
  })
  update(@Param('code') code: string, @Body() dto: UpdateCouponDto) {
    return this.couponsService.update(code, dto);
  }

  @Delete(':code')
  @Auth(AdminRole.SUPER_ADMIN)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Soft-delete (deactivate) a coupon' })
  remove(@Param('code') code: string) {
    return this.couponsService.remove(code);
  }
}
