import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Delete,
  UseInterceptors,
  UploadedFile,
  Req,
} from '@nestjs/common';
import { RafflesService } from './raffles.service';
import { CreateRaffleDto } from './dto/create-raffle.dto';
import { UpdateRaffleDto } from './dto/update-raffle.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Request } from 'express';
import { AdminAuth } from '../auth/decorators/admin-auth.decorator';
import { Admin } from '../auth/entities/admin.entity';

type AuthenticatedRequest = Request & { user: Admin };

@Controller('raffles')
export class RafflesController {
  constructor(private readonly rafflesService: RafflesService) {}

  @Post()
  @AdminAuth()
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
    }),
  )
  async create(
    @Body() createRaffleDto: CreateRaffleDto,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.rafflesService.createWithImage(createRaffleDto, file);
  }

  @Get()
  findAll() {
    return this.rafflesService.findAllEfficient();
  }

  @Get(':uid')
  findOne(@Param('uid') uid: string) {
    return this.rafflesService.findOne(uid);
  }

  @Put(':uid')
  @AdminAuth()
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
    }),
  )
  async update(
    @Param('uid') uid: string,
    @Body() updateRaffleDto: UpdateRaffleDto,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.rafflesService.updateWithImage(
      uid,
      updateRaffleDto,
      file,
      req.user?.uid,
    );
  }

  @Delete(':uid')
  @AdminAuth()
  remove(@Param('uid') uid: string) {
    return this.rafflesService.remove(uid);
  }
}
