declare module 'ws' {
  import type { IncomingMessage } from 'node:http';
  import type { Duplex } from 'node:stream';
  export class WebSocket {
    static readonly OPEN: number;
    readonly readyState: number;
    send(data: string): void;
    close(): void;
  }
  export class WebSocketServer {
    constructor(options: { noServer: true; maxPayload?: number });
    readonly clients: Set<WebSocket>;
    handleUpgrade(request: IncomingMessage,socket: Duplex,head: Buffer,callback:(socket:WebSocket)=>void):void;
    on(event:'connection',listener:(socket:WebSocket)=>void):this;
    emit(event:'connection',socket:WebSocket,request:IncomingMessage):boolean;
    close():void;
  }
}
