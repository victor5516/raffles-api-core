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
import { diskStorage } from 'multer';
import { extname } from 'path';
import { Request } from 'express';

@Controller('raffles')
export class RafflesController {
  constructor(private readonly rafflesService: RafflesService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('image', {
      storage: diskStorage({
        destination: './uploads',
        filename: (req, file, cb) => {
          const randomName = Array(32)
            .fill(null)
            .map(() => Math.round(Math.random() * 16).toString(16))
            .join('');
          cb(null, `${randomName}${extname(file.originalname)}`);
        },
      }),
    }),
  )
  create(
    @Body() createRaffleDto: CreateRaffleDto,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request,
  ) {
    if (file) {
      const protocol = req.protocol;
      const host = req.get('host');
      createRaffleDto.image_url = `${protocol}://${host}/uploads/${file.filename}`;
    }
    return this.rafflesService.create(createRaffleDto);
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
  @UseInterceptors(
    FileInterceptor('image', {
      storage: diskStorage({
        destination: './uploads',
        filename: (req, file, cb) => {
          const randomName = Array(32)
            .fill(null)
            .map(() => Math.round(Math.random() * 16).toString(16))
            .join('');
          cb(null, `${randomName}${extname(file.originalname)}`);
        },
      }),
    }),
  )
  update(
    @Param('uid') uid: string,
    @Body() updateRaffleDto: UpdateRaffleDto,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request,
  ) {
    if (file) {
      const protocol = req.protocol;
      const host = req.get('host');
      updateRaffleDto.image_url = `${protocol}://${host}/uploads/${file.filename}`;
    }
    return this.rafflesService.update(uid, updateRaffleDto);
  }

  @Delete(':uid')
  remove(@Param('uid') uid: string) {
    return this.rafflesService.remove(uid);
  }
}
