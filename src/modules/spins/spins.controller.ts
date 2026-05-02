import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AdminAuth } from '../auth/decorators/admin-auth.decorator';
import { GeneratePromoLinksDto } from './dto/generate-promo-links.dto';
import { ListAdminSpinResultsQueryDto } from './dto/list-admin-spin-results.query.dto';
import { ListCustomerSpinsDto } from './dto/list-customer-spins.dto';
import { ListUnusedPromoTokensQueryDto } from './dto/list-unused-promo-tokens.query.dto';
import { PlaySpinDto } from './dto/play-spin.dto';
import { SpinsService } from './spins.service';

@ApiTags('Spins')
@Controller()
export class SpinsController {
  constructor(private readonly spinsService: SpinsService) {}

  @Post('admin/spins/promo-links')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Generar tokens de promo link para ruleta' })
  @ApiResponse({ status: 201, description: 'Tokens creados exitosamente' })
  @AdminAuth()
  async generatePromoLinks(@Body() dto: GeneratePromoLinksDto) {
    const tokenIds = await this.spinsService.createPromoLinkTokens(dto.quantity);
    return { count: tokenIds.length, tokenIds };
  }

  @Get('admin/spins/results')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Listar historial de resultados de ruleta para admin' })
  @ApiResponse({ status: 200, description: 'Resultados obtenidos correctamente' })
  @AdminAuth()
  findAdminSpinResults(@Query() query: ListAdminSpinResultsQueryDto) {
    return this.spinsService.findAdminSpinResultsPaginated(query);
  }

  @Get('admin/spins/unused-promo-tokens')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Listar tokens promocionales de ruleta sin usar (para distribución)',
  })
  @ApiResponse({ status: 200, description: 'Tokens listados correctamente' })
  @AdminAuth()
  findAdminUnusedPromoTokens(@Query() query: ListUnusedPromoTokensQueryDto) {
    return this.spinsService.findAdminUnusedPromoLinkTokensPaginated(query);
  }

  @Get('customers/me/spins')
  @ApiOperation({
    summary:
      'Listar tokens disponibles de cliente (modo público temporal por customerId)',
  })
  @ApiQuery({
    name: 'customerId',
    required: true,
    description: 'UID del cliente',
  })
  async findCustomerAvailableSpins(@Query() query: ListCustomerSpinsDto) {
    return this.spinsService.findAvailableCustomerTokens(query.customerId);
  }

  @Get('spins/wheel-prizes')
  @ApiOperation({
    summary: 'Listar premios activos para la ruleta (público, sin autenticación)',
  })
  @ApiResponse({
    status: 200,
    description: 'Premios disponibles para mostrar en la ruleta',
  })
  findWheelPrizes() {
    return this.spinsService.findWheelPrizesForPublic();
  }

  @Post('spins/play')
  @ApiOperation({ summary: 'Ejecutar giro de ruleta con token válido' })
  playSpin(@Body() dto: PlaySpinDto) {
    return this.spinsService.spinTheWheel(dto.tokenId);
  }
}
