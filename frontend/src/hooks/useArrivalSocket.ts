"use client";

import { useEffect, useRef, useState } from "react";
import type { CTAEvent } from "@/types/cta";

const RECONNECT_MS = 1500;

export function useArrivalSocket(onEvent: (event: CTAEvent) => void) {
  const onEventRef = useRef(onEvent);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let isActive = true;

    const connect = () => {
      const url = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000/ws";
      socket = new WebSocket(url);

      socket.onopen = () => setIsConnected(true);
      socket.onclose = () => {
        setIsConnected(false);
        if (!isActive) {
          return;
        }
        reconnectTimer = setTimeout(connect, RECONNECT_MS);
      };
      socket.onerror = () => socket?.close();

      socket.onmessage = (message) => {
        try {
          const parsed = JSON.parse(message.data) as CTAEvent;
          onEventRef.current(parsed);
        } catch {
          // Ignore malformed payloads from a transient backend failure.
        }
      };
    };

    connect();

    return () => {
      isActive = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      socket?.close();
    };
  }, []);

  return { isConnected };
}
