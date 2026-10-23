import { useEffect, type RefObject } from 'react';

export type DetectedOmp = {
  projectPath: string;
  ompPath: string;
  result: OmpCapabilitiesResult;
};

// 状态仍由 useAppCore 持有；这里仅管理启动、切目录和更换程序后的异步检测。
export function useOmpCapabilityDetection(
  projectPath: string | undefined,
  ompPath: string,
  checkVersion: number,
  requestRef: RefObject<number>,
  setDetected: (value: DetectedOmp | null) => void,
) {
  useEffect(() => {
    if (!projectPath) return;
    const request = ++requestRef.current;
    let active = true;
    setDetected(null);
    void window.ohMyPiDesktop.detectOmpCapabilities(projectPath).then(
      (result) => {
        if (active && request === requestRef.current) {
          setDetected({ projectPath, ompPath, result });
        }
      },
      () => {
        // 检测失败保持未知，不误报为“不支持”。
      },
    );
    return () => {
      active = false;
    };
  }, [projectPath, ompPath, checkVersion, requestRef, setDetected]);
}
