import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  createConnectedMockZMKApp,
  ZMKAppProvider,
} from "@cormoran/zmk-studio-react-hook/testing";
import { FrameViewer, PMW3610_SUBSYSTEM_IDENTIFIER } from "../src/FrameViewer";
import { Request, Response } from "../src/proto/cormoran/pmw3610/pmw3610";

jest.mock("@zmkfirmware/zmk-studio-ts-client", () => ({
  ...jest.requireActual("@zmkfirmware/zmk-studio-ts-client"),
  call_rpc: jest.fn(),
}));

const envelope = (streaming: boolean, epoch = 19) => ({
  custom: {
    call: {
      payload: Response.encode(
        Response.create({
          setFrameStream: {
            streaming,
            streamEpoch: streaming ? epoch : 0,
            leaseMs: 15000,
          },
        })
      ).finish(),
    },
  },
});

describe("Frame stream client lease", () => {
  beforeEach(() => {
    // RTL's outer automatic cleanup runs after this describe's afterEach.
    // Reset request accounting after the previous session issued its cleanup.
    jest.clearAllMocks();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("renews identical options and stops renewing after disconnect/unmount", async () => {
    jest.useFakeTimers();
    const { call_rpc } = await import("@zmkfirmware/zmk-studio-ts-client");
    const requests: Request[] = [];
    (call_rpc as jest.Mock).mockImplementation((_connection, raw) => {
      const request = Request.decode(raw.custom.call.payload);
      requests.push(request);
      return Promise.resolve(envelope(Boolean(request.setFrameStream?.enable)));
    });
    const app = createConnectedMockZMKApp({
      deviceName: "Synthetic device",
      subsystems: [PMW3610_SUBSYSTEM_IDENTIFIER],
    });
    const view = render(
      <ZMKAppProvider value={app}>
        <FrameViewer />
      </ZMKAppProvider>
    );
    fireEvent.click(screen.getByText(/Start Streaming/i));
    await waitFor(() =>
      expect(screen.getByText(/Stop Streaming/i)).toBeInTheDocument()
    );
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    const starts = requests.filter((request) => request.setFrameStream?.enable);
    expect(starts).toHaveLength(2);
    expect(starts[0].setFrameStream?.renewOnly).toBe(false);
    expect(starts[1].setFrameStream).toEqual({
      ...starts[0].setFrameStream,
      renewOnly: true,
      streamEpoch: 19,
    });
    view.unmount();
    await act(async () => {
      jest.advanceTimersByTime(10000);
    });
    expect(
      requests.filter((request) => request.setFrameStream?.enable)
    ).toHaveLength(2);
    expect(
      requests.some((request) => request.setFrameStream?.enable === false)
    ).toBe(true);
  });

  it("keeps a stop action after an uncertain relay start and does not renew it", async () => {
    jest.useFakeTimers();
    const { call_rpc } = await import("@zmkfirmware/zmk-studio-ts-client");
    (call_rpc as jest.Mock).mockResolvedValue({
      custom: {
        call: {
          payload: Response.encode(
            Response.create({ deferred: { requestId: 7 } })
          ).finish(),
        },
      },
    });
    const app = createConnectedMockZMKApp({
      deviceName: "Synthetic device",
      subsystems: [PMW3610_SUBSYSTEM_IDENTIFIER],
    });
    render(
      <ZMKAppProvider value={app}>
        <FrameViewer />
      </ZMKAppProvider>
    );
    fireEvent.change(screen.getByLabelText(/Split source/i), {
      target: { value: "1" },
    });
    fireEvent.click(screen.getByText(/Start Streaming/i));
    await act(async () => {});
    await act(async () => {
      jest.advanceTimersByTime(6001);
    });
    await waitFor(() =>
      expect(screen.getByText(/Stop Streaming/i)).toBeInTheDocument()
    );
    expect(
      screen.getByText(/Timed out waiting for a PeripheralResponse/)
    ).toBeInTheDocument();
    const calls = (call_rpc as jest.Mock).mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(10000);
    });
    expect(call_rpc).toHaveBeenCalledTimes(calls);
    fireEvent.click(screen.getByText(/Stop Streaming/i));
    await waitFor(() => expect(call_rpc).toHaveBeenCalledTimes(calls + 1));
  });

  it("retires renewal on lock and never resumes it just by unlocking", async () => {
    jest.useFakeTimers();
    const { call_rpc } = await import("@zmkfirmware/zmk-studio-ts-client");
    (call_rpc as jest.Mock).mockResolvedValue(envelope(true));
    const app = createConnectedMockZMKApp({
      deviceName: "Synthetic device",
      subsystems: [PMW3610_SUBSYSTEM_IDENTIFIER],
    });
    const view = render(
      <ZMKAppProvider value={app}>
        <FrameViewer />
      </ZMKAppProvider>
    );
    fireEvent.click(screen.getByText(/Start Streaming/i));
    await waitFor(() =>
      expect(screen.getByText(/Stop Streaming/i)).toBeInTheDocument()
    );
    view.rerender(
      <ZMKAppProvider value={app}>
        <FrameViewer locked />
      </ZMKAppProvider>
    );
    await act(async () => {
      jest.advanceTimersByTime(10000);
    });
    view.rerender(
      <ZMKAppProvider value={app}>
        <FrameViewer />
      </ZMKAppProvider>
    );
    await act(async () => {
      jest.advanceTimersByTime(10000);
    });
    expect(call_rpc).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(call_rpc).toHaveBeenCalledTimes(2);
    const cleanup = Request.decode(
      (call_rpc as jest.Mock).mock.calls[1][1].custom.call.payload
    );
    expect(cleanup.setFrameStream?.enable).toBe(false);
    expect(cleanup.setFrameStream?.renewOnly).toBe(false);
  });

  it("ignores a late renewal response after a confirmed stop", async () => {
    jest.useFakeTimers();
    const { call_rpc } = await import("@zmkfirmware/zmk-studio-ts-client");
    let finishRenewal: (reply: ReturnType<typeof envelope>) => void = () => {};
    (call_rpc as jest.Mock).mockImplementation((_connection, raw) => {
      const request = Request.decode(raw.custom.call.payload).setFrameStream;
      if (request?.renewOnly) {
        return new Promise((resolve) => {
          finishRenewal = resolve;
        });
      }
      return Promise.resolve(envelope(Boolean(request?.enable)));
    });
    const app = createConnectedMockZMKApp({
      deviceName: "Synthetic device",
      subsystems: [PMW3610_SUBSYSTEM_IDENTIFIER],
    });
    render(
      <ZMKAppProvider value={app}>
        <FrameViewer />
      </ZMKAppProvider>
    );
    fireEvent.click(screen.getByText(/Start Streaming/i));
    await waitFor(() =>
      expect(screen.getByText(/Stop Streaming/i)).toBeInTheDocument()
    );
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    fireEvent.click(screen.getByText(/Stop Streaming/i));
    await waitFor(() =>
      expect(screen.getByText(/Start Streaming/i)).toBeInTheDocument()
    );
    await act(async () => {
      finishRenewal(envelope(true));
    });
    await act(async () => {
      jest.advanceTimersByTime(10000);
    });
    expect(screen.getByText(/Start Streaming/i)).toBeInTheDocument();
    const requests = (call_rpc as jest.Mock).mock.calls.map(
      ([, raw]) => Request.decode(raw.custom.call.payload).setFrameStream
    );
    expect(requests.map((request) => request?.enable)).toEqual([
      true,
      true,
      false,
    ]);
    expect(requests.map((request) => request?.renewOnly)).toEqual([
      false,
      true,
      false,
    ]);
    expect(requests.map((request) => request?.streamEpoch)).toEqual([0, 19, 0]);
    expect(call_rpc).toHaveBeenCalledTimes(3);
  });

  it.each(["inactive", "error"])(
    "keeps a replacement stream when an old renewal finishes with %s",
    async (outcome) => {
      jest.useFakeTimers();
      const { call_rpc } = await import("@zmkfirmware/zmk-studio-ts-client");
      let resolveOld!: (reply: ReturnType<typeof envelope>) => void;
      let rejectOld!: (error: Error) => void;
      const oldReply = new Promise<ReturnType<typeof envelope>>(
        (resolve, reject) => {
          resolveOld = resolve;
          rejectOld = reject;
        }
      );
      let starts = 0;
      (call_rpc as jest.Mock).mockImplementation((_connection, raw) => {
        const request = Request.decode(raw.custom.call.payload).setFrameStream!;
        if (request.renewOnly)
          return request.streamEpoch === 19
            ? oldReply
            : Promise.resolve(envelope(true, request.streamEpoch));
        if (request.enable)
          return Promise.resolve(envelope(true, ++starts === 1 ? 19 : 29));
        return Promise.resolve(envelope(false));
      });
      const app = createConnectedMockZMKApp({
        deviceName: "Synthetic device",
        subsystems: [PMW3610_SUBSYSTEM_IDENTIFIER],
      });
      render(
        <ZMKAppProvider value={app}>
          <FrameViewer />
        </ZMKAppProvider>
      );
      fireEvent.click(screen.getByText(/Start Streaming/i));
      await waitFor(() =>
        expect(screen.getByText(/Stop Streaming/i)).toBeInTheDocument()
      );
      await act(async () => {
        jest.advanceTimersByTime(2000);
      });
      fireEvent.click(screen.getByText(/Stop Streaming/i));
      await waitFor(() =>
        expect(screen.getByText(/Start Streaming/i)).toBeInTheDocument()
      );
      fireEvent.click(screen.getByText(/Start Streaming/i));
      await waitFor(() =>
        expect(screen.getByText(/Stop Streaming/i)).toBeInTheDocument()
      );
      await act(async () => {
        if (outcome === "inactive") resolveOld(envelope(false));
        else rejectOld(new Error("Retired renewal failure"));
      });
      expect(screen.getByText(/Stop Streaming/i)).toBeInTheDocument();
      expect(
        screen.queryByText(/Retired renewal failure/)
      ).not.toBeInTheDocument();
      await act(async () => {
        jest.advanceTimersByTime(2000);
      });
      expect(call_rpc).toHaveBeenCalledTimes(5);
      const latest = Request.decode(
        (call_rpc as jest.Mock).mock.calls[4][1].custom.call.payload
      );
      expect(latest.setFrameStream?.renewOnly).toBe(true);
      expect(latest.setFrameStream?.streamEpoch).toBe(29);
    }
  );
});
