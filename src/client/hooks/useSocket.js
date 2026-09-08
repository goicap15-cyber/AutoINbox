import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

const SOCKET_URL = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5050';

export function useSocket(enabled = true) {
  const [socket, setSocket] = useState(null);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setSocket(null);
      setIsConnected(false);
      return undefined;
    }
    const newSocket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      withCredentials: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 2000
    });

    newSocket.on('connect', () => {
      console.log('[Socket.io Client] Đã kết nối thành công:', newSocket.id);
      setIsConnected(true);
    });

    newSocket.on('disconnect', () => {
      console.warn('[Socket.io Client] Ngắt kết nối socket');
      setIsConnected(false);
    });

    setSocket(newSocket);

    return () => {
      newSocket.close();
    };
  }, [enabled]);

  return { socket, isConnected };
}
