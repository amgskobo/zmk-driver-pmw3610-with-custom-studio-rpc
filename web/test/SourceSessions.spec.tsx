import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createConnectedMockZMKApp,
  ZMKAppProvider,
} from "@cormoran/zmk-studio-react-hook/testing";
import { SensorInfo } from "../src/SensorInfo";
import { SettingsPanel } from "../src/SettingsPanel";
import {
  Request as SettingsRequest,
  Response as SettingsResponse,
  Notification as SettingsNotification,
  Setting,
  SettingNotificationKind,
} from "../src/proto/cormoran/zmk/custom_settings/custom_settings";
import {
  Request as SensorRequest,
  Response as SensorResponse,
} from "../src/proto/cormoran/pmw3610/pmw3610";

jest.mock("@zmkfirmware/zmk-studio-ts-client", () => ({
  ...jest.requireActual("@zmkfirmware/zmk-studio-ts-client"),
  call_rpc: jest.fn(),
}));

const envelope = (payload: Uint8Array) => ({ custom: { call: { payload } } });
const settingsStatus = (count: number) =>
  envelope(
    SettingsResponse.encode(
      SettingsResponse.create({ status: { affectedCount: count } })
    ).finish()
  );

const settingsFixture = () => {
  const app = createConnectedMockZMKApp({
    deviceName: "Synthetic device",
    subsystems: ["cormoran_custom_settings", "cormoran__pmw3610"],
  });
  let callback: (notification: {
    subsystemIndex: number;
    payload: Uint8Array;
  }) => void = () => {};
  app.onNotification = jest.fn((subscription) => {
    if (subscription.type === "custom") callback = subscription.callback;
    // Keep the callback callable to exercise an already queued delivery after
    // unsubscribe, as well as the normal active subscription.
    return () => {};
  });
  return {
    app,
    emit: (key: string, source = 0, subsystem = 1) =>
      act(() =>
        callback({
          subsystemIndex: 0,
          payload: SettingsNotification.encode(
            SettingsNotification.create({
              setting: {
                kind: SettingNotificationKind.SETTING_NOTIFICATION_KIND_LIST_ITEM,
                setting: {
                  customSubsystemIndex: subsystem,
                  source,
                  key,
                  value: { int32Value: 900 },
                },
              },
            })
          ).finish(),
        })
      ),
  };
};

describe("Source-scoped RPC sessions", () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it("keeps the most recently selected sensor source when an older request finishes last", async () => {
    const { call_rpc } = await import("@zmkfirmware/zmk-studio-ts-client");
    let resolveLocal: (response: unknown) => void = () => {};
    (call_rpc as jest.Mock).mockImplementation((_connection, request) => {
      const decoded = SensorRequest.decode(request.custom.call.payload);
      if (decoded.getInfo?.source === 0) {
        return new Promise((resolve) => {
          resolveLocal = resolve;
        });
      }
      return Promise.resolve(
        envelope(
          SensorResponse.encode(
            SensorResponse.create({
              getInfo: {
                devices: [
                  {
                    settingsId: "synthetic-peripheral",
                    ready: true,
                    productId: 0x3e,
                  },
                ],
              },
            })
          ).finish()
        )
      );
    });
    const app = createConnectedMockZMKApp({
      deviceName: "Synthetic device",
      subsystems: ["cormoran__pmw3610"],
    });
    render(
      <ZMKAppProvider value={app}>
        <SensorInfo />
      </ZMKAppProvider>
    );
    await waitFor(() => expect(call_rpc).toHaveBeenCalledTimes(1));
    const user = userEvent.setup();
    const input = screen.getByLabelText("Split source");
    await user.clear(input);
    await user.type(input, "1");
    await screen.findByText("synthetic-peripheral");
    await act(async () => {
      resolveLocal(
        envelope(
          SensorResponse.encode(
            SensorResponse.create({
              getInfo: {
                devices: [
                  {
                    settingsId: "synthetic-local",
                    ready: true,
                    productId: 0x3e,
                  },
                ],
              },
            })
          ).finish()
        )
      );
    });
    expect(input).toHaveValue(1);
    expect(screen.getByText("synthetic-peripheral")).toBeInTheDocument();
    expect(screen.queryByText("synthetic-local")).not.toBeInTheDocument();
  });

  it.each([0, 1])(
    "filters settings items to the requested source (received source %i)",
    async (source) => {
      const { call_rpc } = await import("@zmkfirmware/zmk-studio-ts-client");
      let notify: (notification: {
        subsystemIndex: number;
        payload: Uint8Array;
      }) => void = () => {};
      const app = createConnectedMockZMKApp({
        deviceName: "Synthetic device",
        subsystems: ["cormoran_custom_settings", "cormoran__pmw3610"],
      });
      app.onNotification = jest.fn((subscription) => {
        if (subscription.type === "custom") notify = subscription.callback;
        return () => {};
      });
      (call_rpc as jest.Mock).mockImplementation((_connection, request) => {
        const decoded = SettingsRequest.decode(request.custom.call.payload);
        expect(decoded.listSettings?.scope?.source).toBe(0);
        const payload = SettingsNotification.encode(
          SettingsNotification.create({
            setting: {
              kind: SettingNotificationKind.SETTING_NOTIFICATION_KIND_LIST_ITEM,
              setting: Setting.create({
                customSubsystemIndex: 1,
                source,
                key: "synthetic-list-item",
                value: { int32Value: 900 },
              }),
            },
          })
        ).finish();
        notify({ subsystemIndex: 0, payload });
        return Promise.resolve(
          envelope(
            SettingsResponse.encode(
              SettingsResponse.create({
                status: { affectedCount: source === 0 ? 1 : 0 },
              })
            ).finish()
          )
        );
      });
      render(
        <ZMKAppProvider value={app}>
          <SettingsPanel />
        </ZMKAppProvider>
      );
      await screen.findByText(/Loaded/);
      if (source === 0) {
        expect(screen.getByText("synthetic-list-item")).toBeInTheDocument();
        expect(screen.getByText("Loaded 1 setting(s)")).toBeInTheDocument();
      } else {
        expect(
          screen.queryByText("synthetic-list-item")
        ).not.toBeInTheDocument();
        expect(screen.getByText("Loaded 0 setting(s)")).toBeInTheDocument();
      }
    }
  );

  it("counts distinct local keys and ignores another subsystem", async () => {
    const { call_rpc } = await import("@zmkfirmware/zmk-studio-ts-client");
    const fixture = settingsFixture();
    (call_rpc as jest.Mock).mockImplementation(() => {
      fixture.emit("synthetic-first");
      fixture.emit("synthetic-first");
      fixture.emit("synthetic-other-subsystem", 0, 7);
      return Promise.resolve(settingsStatus(2));
    });
    render(
      <ZMKAppProvider value={fixture.app}>
        <SettingsPanel />
      </ZMKAppProvider>
    );
    await waitFor(() => expect(call_rpc).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
    fixture.emit("synthetic-second");
    await screen.findByText("Loaded 2 setting(s)");
    expect(screen.getAllByText("synthetic-first")).toHaveLength(1);
    expect(screen.getByText("synthetic-second")).toBeInTheDocument();
    expect(
      screen.queryByText("synthetic-other-subsystem")
    ).not.toBeInTheDocument();
  });

  it("reports an incomplete list instead of claiming that a partial list loaded", async () => {
    jest.useFakeTimers();
    const { call_rpc } = await import("@zmkfirmware/zmk-studio-ts-client");
    const fixture = settingsFixture();
    (call_rpc as jest.Mock).mockImplementation(() => {
      fixture.emit("synthetic-first");
      return Promise.resolve(settingsStatus(2));
    });
    render(
      <ZMKAppProvider value={fixture.app}>
        <SettingsPanel />
      </ZMKAppProvider>
    );
    await act(async () => {});
    await act(async () => {
      jest.advanceTimersByTime(750);
    });
    expect(
      screen.getByText(/Incomplete settings list: received 1 of 2/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/Loaded 1 setting/)).not.toBeInTheDocument();
  });

  it("retires list callbacks and replies when the connection changes at the same subsystem indexes", async () => {
    const { call_rpc } = await import("@zmkfirmware/zmk-studio-ts-client");
    const old = settingsFixture();
    const fresh = settingsFixture();
    let resolveOld: (response: unknown) => void = () => {};
    (call_rpc as jest.Mock)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          })
      )
      .mockResolvedValue(settingsStatus(0));
    const view = render(
      <ZMKAppProvider value={old.app}>
        <SettingsPanel />
      </ZMKAppProvider>
    );
    await waitFor(() => expect(call_rpc).toHaveBeenCalledTimes(1));
    view.rerender(
      <ZMKAppProvider value={fresh.app}>
        <SettingsPanel />
      </ZMKAppProvider>
    );
    await screen.findByText("Loaded 0 setting(s)");
    old.emit("synthetic-retired");
    await act(async () => {
      resolveOld(settingsStatus(1));
    });
    expect(screen.queryByText("synthetic-retired")).not.toBeInTheDocument();
    expect(screen.getByText("Loaded 0 setting(s)")).toBeInTheDocument();
    expect(call_rpc).toHaveBeenCalledTimes(2);
  });

  it("cancels a pending list on lock and loads a new list after unlock", async () => {
    const { call_rpc } = await import("@zmkfirmware/zmk-studio-ts-client");
    const fixture = settingsFixture();
    let resolveOld: (response: unknown) => void = () => {};
    (call_rpc as jest.Mock)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          })
      )
      .mockResolvedValue(settingsStatus(0));
    const view = render(
      <ZMKAppProvider value={fixture.app}>
        <SettingsPanel />
      </ZMKAppProvider>
    );
    await waitFor(() => expect(call_rpc).toHaveBeenCalledTimes(1));
    view.rerender(
      <ZMKAppProvider value={fixture.app}>
        <SettingsPanel locked />
      </ZMKAppProvider>
    );
    fixture.emit("synthetic-retired");
    await act(async () => {
      resolveOld(settingsStatus(1));
    });
    expect(screen.queryByText("synthetic-retired")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
    view.rerender(
      <ZMKAppProvider value={fixture.app}>
        <SettingsPanel />
      </ZMKAppProvider>
    );
    await screen.findByText("Loaded 0 setting(s)");
    expect(call_rpc).toHaveBeenCalledTimes(2);
  });

  it("does not reload or clear a new connection when an old write completes", async () => {
    const { call_rpc } = await import("@zmkfirmware/zmk-studio-ts-client");
    const old = settingsFixture();
    const fresh = settingsFixture();
    let resolveWrite: (response: unknown) => void = () => {};
    (call_rpc as jest.Mock).mockImplementation((connection, request) => {
      const decoded = SettingsRequest.decode(request.custom.call.payload);
      if (decoded.writeSetting)
        return new Promise((resolve) => {
          resolveWrite = resolve;
        });
      if (connection === old.app.state.connection) {
        old.emit("synthetic-setting");
        return Promise.resolve(settingsStatus(1));
      }
      return Promise.resolve(settingsStatus(0));
    });
    const view = render(
      <ZMKAppProvider value={old.app}>
        <SettingsPanel />
      </ZMKAppProvider>
    );
    await screen.findByText("synthetic-setting");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Write" }));
    view.rerender(
      <ZMKAppProvider value={fresh.app}>
        <SettingsPanel />
      </ZMKAppProvider>
    );
    await screen.findByText("Loaded 0 setting(s)");
    await act(async () => {
      resolveWrite(settingsStatus(1));
    });
    expect(call_rpc).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Loaded 0 setting(s)")).toBeInTheDocument();
    expect(screen.queryByText("synthetic-setting")).not.toBeInTheDocument();
  });

  it("collects early list notifications until a slow immediate reply establishes the count", async () => {
    jest.useFakeTimers();
    const { call_rpc } = await import("@zmkfirmware/zmk-studio-ts-client");
    const fixture = settingsFixture();
    let resolve: (response: unknown) => void = () => {};
    (call_rpc as jest.Mock).mockImplementation(() => {
      fixture.emit("synthetic-first");
      return new Promise((done) => {
        resolve = done;
      });
    });
    render(
      <ZMKAppProvider value={fixture.app}>
        <SettingsPanel />
      </ZMKAppProvider>
    );
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    fixture.emit("synthetic-second");
    await act(async () => {
      resolve(settingsStatus(2));
    });
    expect(screen.getByText("Loaded 2 setting(s)")).toBeInTheDocument();
  });

  it("does not let a previous source's diagnostics replace the selected source", async () => {
    const { call_rpc } = await import("@zmkfirmware/zmk-studio-ts-client");
    let resolveOld: (response: unknown) => void = () => {};
    (call_rpc as jest.Mock).mockImplementation((_connection, request) => {
      const decoded = SensorRequest.decode(request.custom.call.payload);
      if (decoded.getInfo)
        return Promise.resolve(
          envelope(
            SensorResponse.encode(
              SensorResponse.create({ getInfo: { devices: [] } })
            ).finish()
          )
        );
      if (decoded.readDiagnostics?.source === 0)
        return new Promise((resolve) => {
          resolveOld = resolve;
        });
      return Promise.resolve(
        envelope(
          SensorResponse.encode(
            SensorResponse.create({ readDiagnostics: { squal: 34 } })
          ).finish()
        )
      );
    });
    const app = createConnectedMockZMKApp({
      deviceName: "Synthetic device",
      subsystems: ["cormoran__pmw3610"],
    });
    render(
      <ZMKAppProvider value={app}>
        <SensorInfo />
      </ZMKAppProvider>
    );
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Read Once" }));
    fireEvent.change(screen.getByLabelText("Split source"), {
      target: { value: "1" },
    });
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Read Once" }));
    await screen.findByText("34");
    await act(async () => {
      resolveOld(
        envelope(
          SensorResponse.encode(
            SensorResponse.create({ readDiagnostics: { squal: 99 } })
          ).finish()
        )
      );
    });
    expect(screen.getByText("34")).toBeInTheDocument();
    expect(screen.queryByText("99")).not.toBeInTheDocument();
  });

  it("keeps one diagnostics poll in flight so slow replies can finish", async () => {
    jest.useFakeTimers();
    const { call_rpc } = await import("@zmkfirmware/zmk-studio-ts-client");
    let resolve: (response: unknown) => void = () => {};
    let reads = 0;
    (call_rpc as jest.Mock).mockImplementation((_connection, request) => {
      const decoded = SensorRequest.decode(request.custom.call.payload);
      if (decoded.getInfo)
        return Promise.resolve(
          envelope(
            SensorResponse.encode(
              SensorResponse.create({ getInfo: { devices: [] } })
            ).finish()
          )
        );
      reads++;
      return new Promise((done) => {
        resolve = done;
      });
    });
    const app = createConnectedMockZMKApp({
      deviceName: "Synthetic device",
      subsystems: ["cormoran__pmw3610"],
    });
    const view = render(
      <ZMKAppProvider value={app}>
        <SensorInfo />
      </ZMKAppProvider>
    );
    await act(async () => {});
    fireEvent.click(screen.getByRole("checkbox", { name: /Auto-refresh/ }));
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(reads).toBe(1);
    await act(async () => {
      resolve(
        envelope(
          SensorResponse.encode(
            SensorResponse.create({ readDiagnostics: { squal: 73 } })
          ).finish()
        )
      );
    });
    expect(screen.getByText("73")).toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(reads).toBe(2);
    view.unmount();
    await act(async () => {
      resolve(
        envelope(
          SensorResponse.encode(
            SensorResponse.create({ readDiagnostics: { squal: 74 } })
          ).finish()
        )
      );
    });
  });
});
