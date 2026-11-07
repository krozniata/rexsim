// What the clients for idb_companion and the Android emulator share.
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import protobuf from "protobufjs";

export type Message = Record<string, unknown>;

export type Service = grpc.Client & Record<string, any>;

type Stream = grpc.ClientReadableStream<any> | grpc.ClientDuplexStream<Message, any>;

// loadService finds a service, such as idb.CompanionService, in a .proto
// file's text.
export function loadService(proto: string, name: string): grpc.ServiceClientConstructor {
  const definition = protoLoader.fromJSON(protobuf.parse(proto, { keepCase: true }).root.toJSON(), {
    keepCase: true,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  let node: any = grpc.loadPackageDefinition(definition);
  for (const part of name.split(".")) node = node[part];
  return node;
}

// connect opens a channel without TLS, which only a local or Unix socket
// address can do safely. The default 64 KB HTTP/2 window makes a frame of
// several megabytes wait on a window update every 64 KB, which caps the
// stream's frame rate.
export function connect(service: grpc.ServiceClientConstructor, address: string): Service {
  return new service(address, grpc.credentials.createInsecure(), {
    "grpc.max_receive_message_length": 256 << 20,
    "grpc-node.flow_control_window": 16 << 20,
  }) as Service;
}

// unary makes a call with one reply, and cancels it if signal aborts.
export function unary(svc: Service, method: string, req: Message, meta = new grpc.Metadata(), signal?: AbortSignal): Promise<any> {
  return new Promise((resolve, reject) => {
    const call = svc[method](req, meta, (err: grpc.ServiceError | null, res: any) => {
      signal?.removeEventListener("abort", cancel);
      err ? reject(err) : resolve(res);
    });
    const cancel = () => call.cancel();
    signal?.addEventListener("abort", cancel);
  });
}

// readStream passes each message to onData until signal aborts, the stream
// ends or fails, or onData returns an error, and resolves with the reason it
// stopped. ended is the reason when the other side ends the stream.
export function readStream(call: Stream, signal: AbortSignal, ended: string, onData: (msg: any) => Error | void): Promise<Error> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (err: Error) => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", cancel);
      call.cancel();
      resolve(err);
    };
    const cancel = () => finish(new Error("stream stopped"));
    signal.addEventListener("abort", cancel);
    call.on("data", (msg: any) => {
      if (done) return;
      const err = onData(msg);
      if (err) finish(err);
    });
    call.on("end", () => finish(new Error(ended)));
    call.on("error", (err: Error) => finish(err));
  });
}

// Serial runs tasks one at a time in the order they come, so one batch of
// input can't interleave with another. A failed task doesn't hold up the
// next.
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();

  run(task: () => Promise<void>): Promise<void> {
    const next = this.tail.then(task);
    this.tail = next.catch(() => {});
    return next;
  }
}
