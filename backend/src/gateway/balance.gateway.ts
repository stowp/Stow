import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { Logger } from "@nestjs/common";

@WebSocketGateway({
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
  },
  namespace: "/ws/balances",
})
export class BalanceGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(BalanceGateway.name);
  private readonly clientAccounts = new Map<string, Set<string>>();

  async handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  async handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
    this.clientAccounts.delete(client.id);
  }

  @SubscribeMessage("subscribe")
  handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { account: string },
  ) {
    const { account } = data;
    
    if (!this.clientAccounts.has(client.id)) {
      this.clientAccounts.set(client.id, new Set());
    }
    this.clientAccounts.get(client.id)!.add(account);
    
    client.join(`account:${account}`);
    this.logger.debug(`Client ${client.id} subscribed to account ${account}`);
    
    return { event: "subscribed", data: { account } };
  }

  @SubscribeMessage("unsubscribe")
  handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { account: string },
  ) {
    const { account } = data;
    
    this.clientAccounts.get(client.id)?.delete(account);
    client.leave(`account:${account}`);
    this.logger.debug(`Client ${client.id} unsubscribed from account ${account}`);
    
    return { event: "unsubscribed", data: { account } };
  }

  async broadcastBalanceUpdate(account: string, amount: string, updatedAt: Date) {
    this.server.to(`account:${account}`).emit("balance_update", {
      account,
      amount,
      updated_at: updatedAt.toISOString(),
    });
  }
}