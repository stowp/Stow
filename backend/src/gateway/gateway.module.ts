import { Module } from "@nestjs/common";
import { BalanceGateway } from "./balance.gateway";
import { BalanceService } from "../savings/balance.service";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Balance } from "../savings/entities/balance.entity";

@Module({
  imports: [TypeOrmModule.forFeature([Balance])],
  providers: [BalanceGateway, BalanceService],
  exports: [BalanceGateway],
})
export class GatewayModule {}