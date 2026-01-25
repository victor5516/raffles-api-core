import {
  Controller,
  Get,
  Patch,
  Param,
  Query,
  Body,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { CustomersService } from './customers.service';
import { FilterCustomersDto } from './dto/filter-customers.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

@ApiTags('Customers')
@Controller('customers')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get()
  @ApiOperation({ summary: 'Obtener lista de clientes con filtros opcionales' })
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
  @ApiResponse({
    status: 200,
    description: 'Lista de clientes obtenida exitosamente',
  })
  findAll(@Query() query: Record<string, unknown>) {
    return this.customersService.findAll(query);
  }

  @Get(':uid')
  @ApiOperation({ summary: 'Obtener un cliente por su UID con rifas y tickets asociados' })
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
  @ApiOperation({ summary: 'Actualizar información de un cliente' })
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
  @ApiResponse({ status: 404, description: 'Cliente no encontrado' })
  @ApiResponse({ status: 409, description: 'El email ya está en uso' })
  update(@Param('uid') uid: string, @Body() updateDto: UpdateCustomerDto) {
    return this.customersService.update(uid, updateDto);
  }
}
