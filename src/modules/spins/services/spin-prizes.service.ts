import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateSpinPrizeDto } from '../dto/create-spin-prize.dto';
import { UpdateSpinPrizeDto } from '../dto/update-spin-prize.dto';
import { SpinPrize } from '../entities/spin-prize.entity';

@Injectable()
export class SpinPrizesService {
  constructor(
    @InjectRepository(SpinPrize)
    private readonly spinPrizeRepository: Repository<SpinPrize>,
  ) {}

  async findAll(): Promise<SpinPrize[]> {
    return this.spinPrizeRepository.find({
      order: { isActive: 'DESC', weight: 'DESC', createdAt: 'DESC' },
    });
  }

  async create(createDto: CreateSpinPrizeDto): Promise<SpinPrize> {
    const prize = this.spinPrizeRepository.create({
      name: createDto.name.trim(),
      type: createDto.type,
      weight: createDto.weight,
      inventory: createDto.inventory ?? null,
      isActive: createDto.isActive ?? true,
    });
    return this.spinPrizeRepository.save(prize);
  }

  async update(id: string, updateDto: UpdateSpinPrizeDto): Promise<SpinPrize> {
    const existing = await this.spinPrizeRepository.findOne({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Spin prize not found');
    }

    const merged = this.spinPrizeRepository.merge(existing, {
      ...updateDto,
      name: updateDto.name?.trim(),
    });
    return this.spinPrizeRepository.save(merged);
  }

  async remove(id: string): Promise<{ success: true }> {
    const existing = await this.spinPrizeRepository.findOne({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Spin prize not found');
    }
    existing.isActive = false;
    await this.spinPrizeRepository.save(existing);
    return { success: true };
  }
}
