import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createConnectedMockZMKApp,
  ZMKAppProvider,
} from "@cormoran/zmk-studio-react-hook/testing";
import { FrameViewer, PMW3610_SUBSYSTEM_IDENTIFIER } from "../src/FrameViewer";
import {
  Notification,
  Request,
  Response,
} from "../src/proto/cormoran/pmw3610/pmw3610";

// Mock the ZMK client's call_rpc so ZMKCustomSubsystem.callRPC() (used
// directly by FrameViewer, not through useZMKApp) can be controlled per
// test.
jest.mock("@zmkfirmware/zmk-studio-ts-client", () => ({
  ...jest.requireActual("@zmkfirmware/zmk-studio-ts-client"),
  call_rpc: jest.fn(),
}));

describe("FrameViewer Component", () => {
  describe("With Subsystem", () => {
    it("renders capture controls and the size selector", () => {
      const mockZMKApp = createConnectedMockZMKApp({
        deviceName: "Test Device",
        subsystems: [PMW3610_SUBSYSTEM_IDENTIFIER],
      });

      render(
        <ZMKAppProvider value={mockZMKApp}>
          <FrameViewer />
        </ZMKAppProvider>
      );

      expect(
        screen.getByRole("heading", { name: /Frame Viewer/i })
      ).toBeInTheDocument();
      expect(screen.getByText(/Capture Once/i)).toBeInTheDocument();
      expect(screen.getByText(/Start Streaming/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Size/i)).toBeInTheDocument();
    });
  });

  describe("Without Subsystem", () => {
    it("should show a warning when the subsystem is not found", () => {
      const mockZMKApp = createConnectedMockZMKApp({
        deviceName: "Test Device",
        subsystems: [],
      });

      render(
        <ZMKAppProvider value={mockZMKApp}>
          <FrameViewer />
        </ZMKAppProvider>
      );

      expect(
        screen.getByText(/Subsystem "cormoran__pmw3610" not found/i)
      ).toBeInTheDocument();
    });
  });

  describe("Without ZMKAppContext", () => {
    it("should not render when ZMKAppContext is not provided", () => {
      const { container } = render(<FrameViewer />);

      expect(container.firstChild).toBeNull();
    });
  });

  describe("Streaming (SetFrameStream + notifications)", () => {
    const setup = () => {
      const mockZMKApp = createConnectedMockZMKApp({
        deviceName: "Test Device",
        subsystems: [PMW3610_SUBSYSTEM_IDENTIFIER],
      });
      // Capture the registered custom-notification callback so the test can
      // invoke it directly, simulating a FrameStreamChunk notification
      // arriving from the device.
      let notificationCallback:
        | ((n: { subsystemIndex: number; payload: Uint8Array }) => void)
        | null = null;
      mockZMKApp.onNotification = jest.fn((subscription) => {
        if (subscription.type === "custom") {
          notificationCallback = subscription.callback;
        }
        return () => {
          notificationCallback = null;
        };
      });

      return {
        mockZMKApp,
        emit: (payload: Uint8Array) => {
          act(() => {
            notificationCallback?.({ subsystemIndex: 0, payload });
          });
        },
      };
    };

    it("calls SetFrameStream(enable=true) and subscribes to notifications on Start Streaming", async () => {
      const { call_rpc } = await import("@zmkfirmware/zmk-studio-ts-client");
      (call_rpc as jest.Mock).mockResolvedValue({
        custom: {
          call: {
            payload: Response.encode(
              Response.create({ setFrameStream: { streaming: true } })
            ).finish(),
          },
        },
      });

      const { mockZMKApp } = setup();
      render(
        <ZMKAppProvider value={mockZMKApp}>
          <FrameViewer />
        </ZMKAppProvider>
      );

      const user = userEvent.setup();
      await user.click(screen.getByText(/Start Streaming/i));

      await waitFor(() => {
        expect(screen.getByText(/Stop Streaming/i)).toBeInTheDocument();
      });
      expect(mockZMKApp.onNotification).toHaveBeenCalledWith(
        expect.objectContaining({ type: "custom", subsystemIndex: 0 })
      );
    });

    it("assembles and renders a frame from FrameStreamChunk notifications", async () => {
      const { call_rpc } = await import("@zmkfirmware/zmk-studio-ts-client");
      (call_rpc as jest.Mock).mockResolvedValue({
        custom: {
          call: {
            payload: Response.encode(
              Response.create({ setFrameStream: { streaming: true } })
            ).finish(),
          },
        },
      });

      const { mockZMKApp, emit } = setup();
      render(
        <ZMKAppProvider value={mockZMKApp}>
          <FrameViewer />
        </ZMKAppProvider>
      );

      const user = userEvent.setup();
      await user.click(screen.getByText(/Start Streaming/i));
      await waitFor(() => {
        expect(screen.getByText(/Stop Streaming/i)).toBeInTheDocument();
      });

      const totalSize = 4;
      const chunk1 = Notification.encode(
        Notification.create({
          frameStreamChunk: {
            frameId: 1,
            offset: 0,
            data: Uint8Array.from([0x81, 0x82]),
            totalSize,
            complete: true,
          },
        })
      ).finish();
      const chunk2 = Notification.encode(
        Notification.create({
          frameStreamChunk: {
            frameId: 1,
            offset: 2,
            data: Uint8Array.from([0x00, 0x84]),
            totalSize,
            complete: true,
          },
        })
      ).finish();

      emit(chunk1);
      // A single chunk isn't the full frame yet -- pixel count still shows
      // the placeholder.
      expect(screen.getByText("Pixels captured").nextSibling).toHaveTextContent(
        "-"
      );

      emit(chunk2);

      await waitFor(() => {
        expect(screen.getByText("4")).toBeInTheDocument(); // pixelCount
      });
      // One byte (0x00) has bit7 clear -> counted invalid.
      expect(screen.getByText("1")).toBeInTheDocument();
    });

    it("calls SetFrameStream(enable=false) and unsubscribes on Stop Streaming", async () => {
      const { call_rpc } = await import("@zmkfirmware/zmk-studio-ts-client");
      const mockCallRpc = call_rpc as jest.Mock;
      mockCallRpc.mockResolvedValue({
        custom: {
          call: {
            payload: Response.encode(
              Response.create({ setFrameStream: { streaming: true } })
            ).finish(),
          },
        },
      });

      const { mockZMKApp } = setup();
      render(
        <ZMKAppProvider value={mockZMKApp}>
          <FrameViewer />
        </ZMKAppProvider>
      );

      const user = userEvent.setup();
      await user.click(screen.getByText(/Start Streaming/i));
      await waitFor(() => {
        expect(screen.getByText(/Stop Streaming/i)).toBeInTheDocument();
      });

      mockCallRpc.mockResolvedValue({
        custom: {
          call: {
            payload: Response.encode(
              Response.create({ setFrameStream: { streaming: false } })
            ).finish(),
          },
        },
      });

      await user.click(screen.getByText(/Stop Streaming/i));

      await waitFor(() => {
        expect(screen.getByText(/Start Streaming/i)).toBeInTheDocument();
      });

      const lastCallArgs = mockCallRpc.mock.calls.at(-1);
      const requestPayload = lastCallArgs?.[1]?.custom?.call?.payload;
      expect(requestPayload).toBeDefined();
    });

    describe("selected frame dimensions", () => {
      const imageDataDescriptor = Object.getOwnPropertyDescriptor(
        globalThis,
        "ImageData"
      );
      const context = {
        imageSmoothingEnabled: false,
        putImageData: jest.fn(),
        clearRect: jest.fn(),
        drawImage: jest.fn(),
      };
      let getContext: jest.SpyInstance;

      beforeEach(() => {
        context.putImageData.mockClear();
        getContext = jest
          .spyOn(HTMLCanvasElement.prototype, "getContext")
          .mockReturnValue(context as unknown as CanvasRenderingContext2D);
        Object.defineProperty(globalThis, "ImageData", {
          configurable: true,
          value: jest.fn(
            (data: Uint8ClampedArray, width: number, height: number) => {
              if (data.length !== width * height * 4) {
                throw new DOMException("Pixel dimensions do not match");
              }
              return { data, width, height, colorSpace: "srgb" };
            }
          ),
        });
      });

      afterEach(() => {
        getContext.mockRestore();
        if (imageDataDescriptor) {
          Object.defineProperty(globalThis, "ImageData", imageDataDescriptor);
        } else {
          Reflect.deleteProperty(globalThis, "ImageData");
        }
      });

      it.each([
        { side: 19, totalSize: 361 },
        { side: 20, totalSize: 400 },
        { side: 21, totalSize: 441 },
        { side: 22, totalSize: 484 },
        { side: 19, totalSize: 360 },
      ])(
        "renders $totalSize pixels using selected side $side",
        async ({ side, totalSize }) => {
          const { call_rpc } =
            await import("@zmkfirmware/zmk-studio-ts-client");
          (call_rpc as jest.Mock).mockResolvedValue({
            custom: {
              call: {
                payload: Response.encode(
                  Response.create({ setFrameStream: { streaming: true } })
                ).finish(),
              },
            },
          });
          const { mockZMKApp, emit } = setup();
          render(
            <ZMKAppProvider value={mockZMKApp}>
              <FrameViewer />
            </ZMKAppProvider>
          );
          const user = userEvent.setup();
          await user.selectOptions(
            screen.getByLabelText(/^Size$/),
            String(side)
          );
          await user.click(screen.getByText(/Start Streaming/i));
          await screen.findByText(/Stop Streaming/i);
          for (let offset = 0; offset < totalSize; offset += 128) {
            emit(
              Notification.encode(
                Notification.create({
                  frameStreamChunk: {
                    frameId: 1,
                    offset,
                    data: new Uint8Array(
                      Math.min(128, totalSize - offset)
                    ).fill(0x81),
                    totalSize,
                    complete: true,
                  },
                })
              ).finish()
            );
          }
          expect(context.putImageData).toHaveBeenCalledWith(
            expect.objectContaining({
              width: side,
              height: Math.ceil(totalSize / side),
            }),
            0,
            0
          );
          expect(
            screen.getByText("Pixels captured").nextSibling
          ).toHaveTextContent(String(totalSize));
        }
      );
    });

    describe("stream ownership", () => {
      const reply = (streaming: boolean) => ({
        custom: {
          call: {
            payload: Response.encode(
              Response.create({ setFrameStream: { streaming } })
            ).finish(),
          },
        },
      });

      it("returns to idle after Studio locks during a one-shot capture", async () => {
        const { call_rpc } = await import("@zmkfirmware/zmk-studio-ts-client");
        let finishCapture!: (value: ReturnType<typeof reply>) => void;
        (call_rpc as jest.Mock)
          .mockReset()
          .mockImplementationOnce(
            () => new Promise((resolve) => (finishCapture = resolve))
          );
        const { mockZMKApp } = setup();
        const { rerender } = render(
          <ZMKAppProvider value={mockZMKApp}>
            <FrameViewer />
          </ZMKAppProvider>
        );
        await userEvent.setup().click(screen.getByText(/Capture Once/i));
        rerender(
          <ZMKAppProvider value={mockZMKApp}>
            <FrameViewer locked />
          </ZMKAppProvider>
        );
        await act(async () =>
          finishCapture({
            custom: {
              call: {
                payload: Response.encode(
                  Response.create({
                    captureFrame: {
                      frameId: 1,
                      pixelCount: 484,
                      chunkSize: 128,
                      complete: true,
                    },
                  })
                ).finish(),
              },
            },
          })
        );
        rerender(
          <ZMKAppProvider value={mockZMKApp}>
            <FrameViewer />
          </ZMKAppProvider>
        );
        expect(screen.getByText(/Start Streaming/i)).toBeEnabled();
        expect(screen.getByText(/Capture Once/i)).toBeEnabled();
        expect(call_rpc).toHaveBeenCalledTimes(1);
      });

      it("reports a missing SetFrameStream ACK instead of treating it as stopped", async () => {
        const { call_rpc } = await import("@zmkfirmware/zmk-studio-ts-client");
        (call_rpc as jest.Mock).mockReset().mockResolvedValue({
          custom: {
            call: { payload: Response.encode(Response.create({})).finish() },
          },
        });
        const { mockZMKApp } = setup();
        render(
          <ZMKAppProvider value={mockZMKApp}>
            <FrameViewer />
          </ZMKAppProvider>
        );
        await userEvent.setup().click(screen.getByText(/Start Streaming/i));
        expect(
          await screen.findByText(/SetFrameStream response missing/i)
        ).toBeInTheDocument();
      });

      it("disables conflicting controls while a start is awaiting its ACK", async () => {
        const { call_rpc } = await import("@zmkfirmware/zmk-studio-ts-client");
        const mockCallRpc = call_rpc as jest.Mock;
        let finishStart!: (value: ReturnType<typeof reply>) => void;
        mockCallRpc
          .mockReset()
          .mockImplementationOnce(
            () => new Promise((resolve) => (finishStart = resolve))
          );
        const { mockZMKApp } = setup();
        render(
          <ZMKAppProvider value={mockZMKApp}>
            <FrameViewer />
          </ZMKAppProvider>
        );
        const user = userEvent.setup();
        await user.click(screen.getByText(/Start Streaming/i));
        expect(
          screen.getByRole("button", { name: /Start Streaming|Starting/i })
        ).toBeDisabled();
        expect(screen.getByText(/Capture Once/i)).toBeDisabled();
        expect(screen.getByLabelText(/^Size$/)).toBeDisabled();
        expect(screen.getByLabelText(/Split source/i)).toBeDisabled();
        await act(async () => finishStart(reply(true)));
        expect(mockCallRpc).toHaveBeenCalledTimes(1);
      });

      it("keeps Stop available for retry when stopping fails", async () => {
        const { call_rpc } = await import("@zmkfirmware/zmk-studio-ts-client");
        const mockCallRpc = call_rpc as jest.Mock;
        mockCallRpc.mockReset().mockResolvedValue(reply(true));
        const { mockZMKApp } = setup();
        render(
          <ZMKAppProvider value={mockZMKApp}>
            <FrameViewer />
          </ZMKAppProvider>
        );
        const user = userEvent.setup();
        await user.click(screen.getByText(/Start Streaming/i));
        await screen.findByText(/Stop Streaming/i);
        mockCallRpc.mockRejectedValueOnce(new Error("Stop failed"));
        await user.click(screen.getByText(/Stop Streaming/i));
        await screen.findByText("Stop failed");
        expect(screen.getByText(/Stop Streaming/i)).toBeEnabled();
        mockCallRpc.mockResolvedValueOnce(reply(false));
        await user.click(screen.getByText(/Stop Streaming/i));
        expect(await screen.findByText(/Start Streaming/i)).toBeEnabled();
      });

      it("retires a start ACK arriving after Studio locks", async () => {
        const { call_rpc } = await import("@zmkfirmware/zmk-studio-ts-client");
        const mockCallRpc = call_rpc as jest.Mock;
        let finishStart!: (value: ReturnType<typeof reply>) => void;
        mockCallRpc
          .mockReset()
          .mockImplementationOnce(
            () => new Promise((resolve) => (finishStart = resolve))
          )
          .mockResolvedValue(reply(false));
        const { mockZMKApp } = setup();
        const { rerender } = render(
          <ZMKAppProvider value={mockZMKApp}>
            <FrameViewer />
          </ZMKAppProvider>
        );
        await userEvent.setup().click(screen.getByText(/Start Streaming/i));
        rerender(
          <ZMKAppProvider value={mockZMKApp}>
            <FrameViewer locked />
          </ZMKAppProvider>
        );
        await act(async () => finishStart(reply(true)));
        expect(screen.queryByText(/Stop Streaming/i)).not.toBeInTheDocument();
        expect(screen.getByText(/Start Streaming/i)).toBeDisabled();
        expect(mockCallRpc).toHaveBeenCalledTimes(2);
        const payload =
          mockCallRpc.mock.calls.at(-1)?.[1]?.custom?.call?.payload;
        expect(Request.decode(payload).setFrameStream?.enable).toBe(false);
      });

      it("stops an owned stream on unmount using its original connection", async () => {
        const { call_rpc } = await import("@zmkfirmware/zmk-studio-ts-client");
        const mockCallRpc = call_rpc as jest.Mock;
        mockCallRpc.mockReset().mockResolvedValue(reply(true));
        const { mockZMKApp } = setup();
        const { unmount } = render(
          <ZMKAppProvider value={mockZMKApp}>
            <FrameViewer />
          </ZMKAppProvider>
        );
        await userEvent.setup().click(screen.getByText(/Start Streaming/i));
        await screen.findByText(/Stop Streaming/i);
        mockCallRpc.mockResolvedValue(reply(false));
        unmount();
        await waitFor(() => expect(mockCallRpc).toHaveBeenCalledTimes(2));
        const lastCall = mockCallRpc.mock.calls.at(-1)!;
        expect(lastCall[0]).toBe(mockZMKApp.state.connection);
        expect(
          Request.decode(lastCall[1].custom.call.payload).setFrameStream?.enable
        ).toBe(false);
      });

      it("does not activate a replacement connection from a retired start", async () => {
        const { call_rpc } = await import("@zmkfirmware/zmk-studio-ts-client");
        const mockCallRpc = call_rpc as jest.Mock;
        let finishStart!: (value: ReturnType<typeof reply>) => void;
        mockCallRpc
          .mockReset()
          .mockImplementationOnce(
            () => new Promise((resolve) => (finishStart = resolve))
          )
          .mockResolvedValue(reply(false));
        const original = setup().mockZMKApp;
        const replacement = setup().mockZMKApp;
        const { rerender } = render(
          <ZMKAppProvider value={original}>
            <FrameViewer />
          </ZMKAppProvider>
        );
        await userEvent.setup().click(screen.getByText(/Start Streaming/i));
        rerender(
          <ZMKAppProvider value={replacement}>
            <FrameViewer />
          </ZMKAppProvider>
        );
        await act(async () => finishStart(reply(true)));
        expect(screen.queryByText(/Stop Streaming/i)).not.toBeInTheDocument();
        const lastCall = mockCallRpc.mock.calls.at(-1)!;
        expect(lastCall[0]).toBe(original.state.connection);
        expect(
          Request.decode(lastCall[1].custom.call.payload).setFrameStream?.enable
        ).toBe(false);
      });

      it("ignores frame notifications from a different split source", async () => {
        const { call_rpc } = await import("@zmkfirmware/zmk-studio-ts-client");
        (call_rpc as jest.Mock).mockReset().mockResolvedValue(reply(true));
        const { mockZMKApp, emit } = setup();
        render(
          <ZMKAppProvider value={mockZMKApp}>
            <FrameViewer />
          </ZMKAppProvider>
        );
        await userEvent.setup().click(screen.getByText(/Start Streaming/i));
        await screen.findByText(/Stop Streaming/i);
        emit(
          Notification.encode(
            Notification.create({
              frameStreamChunk: {
                frameId: 1,
                offset: 0,
                source: 1,
                data: new Uint8Array(4).fill(0x81),
                totalSize: 4,
                complete: true,
              },
            })
          ).finish()
        );
        expect(
          screen.getByText("Pixels captured").nextSibling
        ).toHaveTextContent("-");
      });
    });
  });

  describe("Locked state", () => {
    it("disables capture and streaming controls when locked", () => {
      const mockZMKApp = createConnectedMockZMKApp({
        deviceName: "Test Device",
        subsystems: [PMW3610_SUBSYSTEM_IDENTIFIER],
      });

      render(
        <ZMKAppProvider value={mockZMKApp}>
          <FrameViewer locked={true} />
        </ZMKAppProvider>
      );

      expect(screen.getByText(/Capture Once/i)).toBeDisabled();
      expect(screen.getByText(/Start Streaming/i)).toBeDisabled();
    });
  });
});
