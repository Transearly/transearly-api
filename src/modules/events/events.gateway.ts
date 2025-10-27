import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
  pingInterval: 25000,
  pingTimeout: 60000,
})
export class EventsGateway {
  @WebSocketServer()
  server: Server;

  handleConnection(client: Socket) {
    const socketId = client.id;
  
    client.emit('welcome', `Hello! Your socket ID is ${socketId}`);
  }

  /**
   * @param socketId ID của socket client
   * @param event Tên của sự kiện (ví dụ: 'translationComplete')
   * @param data Dữ liệu cần gửi
   */
  sendJobUpdateToClient(socketId: string, event: string, data: any) {
    if (socketId && this.server) {
      // console.log('\n--- 📤 Sending WebSocket Event ---');
      // console.log(`   - Event Name: ${event}`);
      // console.log(`   - To Socket ID: ${socketId}`);
      // console.log('   - Data Payload:', JSON.stringify(data, null, 2));
      // console.log('---------------------------------\n');
      this.server.to(socketId).emit(event, data);
    }
  }
}