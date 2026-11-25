"use client";

interface AriaLiveProps {
  message: string;
  politeness?: "polite" | "assertive";
}

export default function AriaLive({
  message,
  politeness = "polite",
}: AriaLiveProps) {
  return (
    <div
      role={politeness === "assertive" ? "alert" : "status"}
      aria-live={politeness}
      aria-atomic="true"
      className="sr-only"
    >
      {message}
    </div>
  );
}
