/**
 * 轻量 toast 通知系统：右下角堆叠，自动消失。
 *
 * 设计取舍：
 *   - 自实现（不引 sonner / react-hot-toast 等依赖）
 *   - Context + Portal 模式：所有页面共用一个 ToastProvider
 *   - 调用方语义清晰：useToast().success('已保存') / .error(msg) / .info(msg)
 *   - 错误 toast 默认 5s（信息更重要，需要更多阅读时间），其他 3s
 */

import { CheckCircle2, Info, X, XCircle } from 'lucide-react';
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { Button } from '@/components/ui/button.js';

type ToastKind = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  durationMs: number;
}

interface ToastApi {
  success: (msg: string, durationMs?: number) => void;
  error: (msg: string, durationMs?: number) => void;
  info: (msg: string, durationMs?: number) => void;
  /** 主动关闭某条 toast（通常用户不需要直接调用） */
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const DEFAULT_DURATION_MS: Record<ToastKind, number> = {
  success: 3000,
  info: 3000,
  error: 5000,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idCounterRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string, durationMs?: number) => {
      const id = ++idCounterRef.current;
      const duration = durationMs ?? DEFAULT_DURATION_MS[kind];
      setToasts((prev) => [...prev, { id, kind, message, durationMs: duration }]);
      // 到时自动 dismiss；用户主动点 X 也可提前关闭
      setTimeout(() => dismiss(id), duration);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (msg, durationMs) => push('success', msg, durationMs),
      error: (msg, durationMs) => push('error', msg, durationMs),
      info: (msg, durationMs) => push('info', msg, durationMs),
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* Portal 容器：fixed 定位，不受父级 overflow 影响 */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <ToastCard key={t.id} item={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  // 入场动画：mount 后下一帧加 opacity-100 触发 transition
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const config = {
    success: {
      icon: CheckCircle2,
      classes: 'border-green-500/30 bg-green-500/10 text-green-400',
    },
    error: {
      icon: XCircle,
      classes: 'border-destructive/30 bg-destructive/10 text-destructive',
    },
    info: {
      icon: Info,
      classes: 'border-blue-500/30 bg-blue-500/10 text-blue-400',
    },
  }[item.kind];

  const Icon = config.icon;

  return (
    <output
      className={`pointer-events-auto flex min-w-[280px] max-w-md items-start gap-3 rounded-lg border bg-background/95 p-3 text-sm shadow-lg backdrop-blur transition-all duration-200 ${
        visible ? 'translate-x-0 opacity-100' : 'translate-x-4 opacity-0'
      } ${config.classes}`}
    >
      <Icon className="mt-0.5 h-4 w-4 flex-shrink-0" />
      <div className="flex-1 break-words text-foreground">{item.message}</div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="-mr-1 h-6 w-6 flex-shrink-0"
        onClick={onDismiss}
      >
        <X className="h-3 w-3" />
      </Button>
    </output>
  );
}

/**
 * Hook：获取 toast API。必须在 ToastProvider 树内使用。
 */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be called inside <ToastProvider>');
  }
  return ctx;
}
