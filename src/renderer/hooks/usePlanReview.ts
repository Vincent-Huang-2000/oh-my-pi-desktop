import { useState } from 'react';
import type { useAppCore } from './useAppCore';

export function usePlanReview(app: ReturnType<typeof useAppCore>) {
  const [notice, setNotice] = useState<{ sessionId: string; text: string } | null>(null);
  const session = app.selectedSession;
  const view = session ? app.planReviewBySession[session.id] : undefined;
  const open = async () => {
    if (!session || session.projectPath !== app.selectedProject?.path) return;
    setNotice(null);
    if (view?.review) {
      app.setHiddenPlanReviews((current) => ({ ...current, [session.id]: '' }));
      return;
    }
    try {
      const result = await window.ohMyPiDesktop.reopenPlanReview(session.id, session.projectPath);
      if (!result.ok) setNotice({ sessionId: session.id, text: result.message ?? '无法打开方案' });
      else app.setHiddenPlanReviews((current) => ({ ...current, [session.id]: '' }));
    } catch {
      setNotice({ sessionId: session.id, text: '无法打开方案，请重试' });
    }
  };
  const hide = () => {
    if (session && view?.review)
      app.setHiddenPlanReviews((current) => ({ ...current, [session.id]: view.review!.reviewId }));
  };
  return {
    view,
    open,
    hide,
    notice: notice?.sessionId === session?.id ? notice?.text : undefined,
    visible: Boolean(
      session &&
      view?.review &&
      app.hiddenPlanReviews[session.id] !== view.review.reviewId &&
      !app.activeApprovalKind,
    ),
  };
}
