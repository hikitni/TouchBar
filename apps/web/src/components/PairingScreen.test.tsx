import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PairingScreen } from "./PairingScreen";

describe("PairingScreen", () => {
  it("accepts only a six-digit code and submits the named device", async () => {
    const user = userEvent.setup();
    const onPair = vi.fn().mockResolvedValue(undefined);
    render(<PairingScreen busy={false} error={null} onPair={onPair} />);

    expect(screen.getByText("MAC 副屏控制台 · v1.3")).toBeInTheDocument();

    const submit = screen.getByRole("button", { name: "连接 Mac" });
    expect(submit).toBeDisabled();

    await user.clear(screen.getByLabelText("设备名称"));
    await user.type(screen.getByLabelText("设备名称"), "Kitchen iPad");
    await user.type(screen.getByLabelText("配对码"), "12a34567");

    expect(screen.getByLabelText("配对码")).toHaveValue("123456");
    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(onPair).toHaveBeenCalledWith("123456", "Kitchen iPad");
  });
});
