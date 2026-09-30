import React, { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AmountInput, type AmountInputProps } from "./AmountInput";

function Harness({
  initial = "",
  onAmount,
  ...props
}: Partial<AmountInputProps> & {
  initial?: string;
  onAmount?: (value: string, stroops: bigint | null) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <AmountInput
      locale="en-US"
      {...props}
      value={value}
      onChange={(next, stroops) => {
        setValue(next);
        onAmount?.(next, stroops);
      }}
    />
  );
}

function getInput(): HTMLInputElement {
  return screen.getByLabelText("Amount") as HTMLInputElement;
}

describe("AmountInput", () => {
  it("renders a labelled decimal text input with a USDC suffix", () => {
    render(<Harness />);
    const input = getInput();
    expect(input).toHaveAttribute("inputmode", "decimal");
    expect(input).toHaveAttribute("type", "text");
    expect(screen.getByText("USDC")).toBeInTheDocument();
  });

  it("reports the parsed amount in stroops", () => {
    const onAmount = vi.fn();
    render(<Harness onAmount={onAmount} />);

    fireEvent.change(getInput(), { target: { value: "12.5" } });
    expect(onAmount).toHaveBeenLastCalledWith("12.5", BigInt(125000000));
  });

  it("reports null for incomplete input", () => {
    const onAmount = vi.fn();
    render(<Harness onAmount={onAmount} />);

    fireEvent.change(getInput(), { target: { value: "." } });
    expect(onAmount).toHaveBeenLastCalledWith(".", null);
  });

  it("rejects keystrokes beyond 7 decimals or with foreign characters", () => {
    const onAmount = vi.fn();
    render(<Harness initial="1.1234567" onAmount={onAmount} />);

    fireEvent.change(getInput(), { target: { value: "1.12345678" } });
    fireEvent.change(getInput(), { target: { value: "1.1234567e" } });
    fireEvent.change(getInput(), { target: { value: "1.1.1" } });
    expect(onAmount).not.toHaveBeenCalled();
    expect(getInput()).toHaveValue("1.1234567");
  });

  it("normalizes to locale formatting on blur", () => {
    render(<Harness initial="1234567.5" />);
    fireEvent.blur(getInput());
    expect(getInput()).toHaveValue("1,234,567.5");
  });

  it("accepts the locale's own decimal mark", () => {
    const onAmount = vi.fn();
    render(<Harness locale="de-DE" onAmount={onAmount} />);

    fireEvent.change(getInput(), { target: { value: "1.234,5" } });
    expect(onAmount).toHaveBeenLastCalledWith("1.234,5", BigInt(12345000000));
  });

  it("shows a validation error only after blur", () => {
    render(<Harness initial="0" />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.blur(getInput());
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Amount must be greater than 0.",
    );
    expect(getInput()).toHaveAttribute("aria-invalid", "true");
  });

  it("enforces max and fills it via the Max button", () => {
    const onAmount = vi.fn();
    render(
      <Harness initial="101" max={BigInt(1_000_000_000)} onAmount={onAmount} />,
    );

    fireEvent.blur(getInput());
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Maximum amount is 100 USDC.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Max" }));
    expect(onAmount).toHaveBeenLastCalledWith("100", BigInt(1_000_000_000));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("prefers an external error and links it via aria-describedby", () => {
    render(<Harness initial="5" error="Insufficient balance" hint="Hint" />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Insufficient balance");
    expect(getInput()).toHaveAttribute("aria-describedby", alert.id);
    expect(screen.queryByText("Hint")).not.toBeInTheDocument();
  });
});
