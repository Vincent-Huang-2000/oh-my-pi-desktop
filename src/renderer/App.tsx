import { ChatWorkspace } from './components/ChatWorkspace';
import { ContextPane } from './components/ContextPane';
import { ElicitationModal } from './components/ElicitationModal';
import {
  GitBranchSwitchErrorModal,
  resolveGitBranchSwitchFailure,
  type GitBranchSwitchError
} from './components/GitBranchSwitchErrorModal';
import { PermissionModal } from './components/PermissionModal';
import { QuestionnaireModal } from './components/QuestionnaireModal';
import { ProjectPane } from './components/ProjectPane';
import { SessionSearchModal, type SessionSearchItem } from './components/SessionSearchModal';
import { StatusBar } from './components/StatusBar';
import { TopBar } from './components/TopBar';
import type { AcpConfigOption, ChatMessage, ElicitationRequest, PermissionOption, PermissionRequest, QuestionnaireAnswer, QuestionnaireRequest } from './types';
import {
  getElicitationKind,
  getLogLevel,
  getPayloadAvailableCommands,
  getPayloadConfigOptions,
  getPayloadElicitationField,
  getPayloadFullPlan,
  getPayloadQuestionnaire,
  getPayloadPermissionOptions,
  getPayloadRequestId,
  splitElicitationPlan
} from './utils';
import { type PendingAttachment, classifyAttachment } from './lib/attachments';
import { DEFAULT_APPROVAL_PROFILE, MAX_IMAGE_BYTES, REVIEW_SOURCE_LABEL, type DraftConfigValues, type PaneSide, type ReviewSource } from './lib/constants';
import { getElicitationResultText } from './lib/elicitationText';
import { applyActiveSessionPlan, getActiveSessionPlan, getHistoryLoadedEvents, getHistoryLoadedPlans, insertHistoricalPlans } from './lib/historyLoaders';
import { mergeAgentEventIntoMessages } from './lib/messageMerge';
import { type PendingSlashCommand, parseSlashCommand, resolveCommandPendingMeta } from './lib/slashCommands';
import { usePaneLayout } from './hooks/usePaneLayout';
import { useToolGroups } from './hooks/useToolGroups';
import { useAppCore } from './hooks/useAppCore';
import { useGitReview } from './hooks/useGitReview';
import { useProjectActions } from './hooks/useProjectActions';
import { useSessionLifecycle } from './hooks/useSessionLifecycle';
import { useMessageFlow } from './hooks/useMessageFlow';
import { useAgentEvents } from './hooks/useAgentEvents';
import { useApprovalFlow } from './hooks/useApprovalFlow';
import { useConfigSync } from './hooks/useConfigSync';
import './styles.css';

const EMPTY_ELICITATION_REQUESTS: ElicitationRequest[] = [];


export default function App() {
  const app = useAppCore();
  const paneLayout = usePaneLayout();
  const toolGroups = useToolGroups(app.selectedSession, app.messageCache);


  const gitReview = useGitReview(app);

  const projectActions = useProjectActions(app, toolGroups);

  const sessionLifecycle = useSessionLifecycle(app, toolGroups, projectActions);
  const messageFlow = useMessageFlow(app);

  const approvalFlow = useApprovalFlow(app);
  const configSync = useConfigSync(app);
  useAgentEvents(app, toolGroups, gitReview.refreshGitBranches, gitReview.refreshDiff);


  return (
    <main className={paneLayout.appShellClassName} style={paneLayout.layoutStyle}>
      {!paneLayout.leftCollapsed && (
        <ProjectPane
          onTogglePane={paneLayout.collapseLeftPane}
          desktopState={app.desktopState}
          projects={app.displayedProjects}
          selectedProject={app.selectedProject}
          selectedSession={app.selectedSession}
          sessionsForProject={app.sessionsForProject}
          expandedProjectPaths={app.expandedProjectPaths}
          onSelectWorkspace={() => void projectActions.handleSelectWorkspace()}
          onToggleProjectExpanded={projectActions.toggleProjectExpanded}
          onNewSession={() => void sessionLifecycle.handleNewSession()}
          onNewProjectSession={(project) => void sessionLifecycle.handleNewSession(project)}
          onOpenSessionSearch={() => app.setSessionSearchOpen(true)}
          onSyncSessions={() => app.selectedProject && void sessionLifecycle.syncProjectSessions(app.selectedProject.path)}
          onSelectProjectSession={(project, session) => void sessionLifecycle.handleSelectProjectSession(project, session)}
          onToggleProjectPinned={(project) => void projectActions.handleToggleProjectPinned(project)}
          onRevealProject={(project) => void projectActions.handleRevealProject(project)}
          onRenameProject={(project, name) => void projectActions.handleRenameProject(project, name)}
          onRemoveProject={(project) => void projectActions.handleRemoveProject(project)}
          onForkSession={(project, session) => void sessionLifecycle.handleForkSession(project, session)}
          onCloseSession={(project, session) => void sessionLifecycle.handleCloseSession(session)}
        />
      )}
      {paneLayout.leftCollapsed && (
        <button
          className="left-pane-restore-button"
          type="button"
          onClick={paneLayout.expandLeftPane}
          aria-label="展开左侧项目栏"
          title="展开左侧项目栏"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="2" y="2.5" width="12" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M6 3v10" stroke="currentColor" strokeWidth="1.4" />
            <path d="M9 6l2 2-2 2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      <TopBar
        projectName={app.selectedProject?.name}
        sessionTitle={app.selectedSession?.title}
        ompStatus={app.ompStatus}
        ompPath={app.ompPath}
        leftCollapsed={paneLayout.leftCollapsed}
        rightCollapsed={paneLayout.rightCollapsed}
        onToggleLeftPane={paneLayout.toggleLeftPane}
        onToggleRightPane={paneLayout.toggleRightPane}
        onSelectOmpPath={() => void projectActions.handleSelectOmpPath()}
        onSelectWorkspace={() => void projectActions.handleSelectWorkspace()}
      />
      <section className={paneLayout.layoutClassName}>
        <ChatWorkspace
          messages={app.messages}
          prompt={app.prompt}
          pendingAttachments={app.pendingAttachments}
          selectedProject={app.selectedProject}
          selectedSession={app.selectedSession}
          canCancel={app.isAgentBusy}
          availableCommands={app.displayedCommands}
          pendingSlashCommand={app.pendingSlashCommand}
          collapsedToolGroups={toolGroups.collapsedToolGroups}
          isHistoryLoading={app.loadingHistorySessionId === app.selectedSession?.id}
          historyScrollResetToken={app.historyScrollResetToken}
          elicitationRequests={app.elicitationBySession.current[app.selectedSession?.id ?? ''] ?? EMPTY_ELICITATION_REQUESTS}
          modelConfig={app.modelConfig}
          modeConfig={app.modeConfig}
          thinkingConfig={app.thinkingConfig}
          approvalProfile={app.currentApprovalProfile}
          approvalProfileNotice={app.approvalProfileNotice}
          isDraftSession={!app.selectedSession}
          onModelChange={(modelId) => void configSync.handleModelChange(modelId)}
          onModeChange={(modeId) => void configSync.handleModeChange(modeId)}
          onThinkingChange={(thinkingId) => void configSync.handleThinkingChange(thinkingId)}
          onApprovalProfileChange={(approvalProfile) =>
            void configSync.handleApprovalProfileChange(approvalProfile)
          }
          onPromptChange={app.setPrompt}
          onRemovePendingAttachment={(index) =>
            app.setPendingAttachments((current) => current.filter((_, idx) => idx !== index))
          }
          onSelectFile={messageFlow.handleSelectFile}
          onPaste={messageFlow.handlePaste}
          onSubmit={(event) => void messageFlow.handleSubmit(event)}
          onCancel={() => void messageFlow.handleCancelTurn()}
          onElicitationRespond={(requestId, action, content) => void approvalFlow.handleElicitation(requestId, action, content)}
          onSetToolGroupCollapsed={toolGroups.handleSetToolGroupCollapsed}
        />

        {!paneLayout.rightCollapsed && (
          <ContextPane
            selectedProject={app.selectedProject}
            diffText={app.diffText}
            diffStatus={app.diffStatus}
            gitBranches={app.gitBranches}
            currentGitBranch={app.currentGitBranch}
            gitBranchNotice={app.gitBranchNotice}
            switchingGitBranch={app.switchingGitBranch}
            reviewSource={app.reviewSource}
            onGitBranchChange={(branchName) => void gitReview.handleGitBranchChange(branchName)}
            onReviewSourceChange={(source) => void gitReview.handleReviewSourceChange(source)}
            onSyncGitReview={gitReview.syncGitReview}
            onRefreshReview={() => void gitReview.handleRefreshGitReview()}
          />
        )}
        {!paneLayout.rightCollapsed && (
          <div
            className={paneLayout.rightHandleClassName}
            role="separator"
            aria-label="调整右侧上下文栏宽度"
            aria-orientation="vertical"
            title={paneLayout.collapsePreviewSide === 'right' ? '松开将折叠' : '拖拽调整右侧上下文栏宽度，双击折叠'}
            onMouseDown={(event) => paneLayout.startPaneResize('right', event)}
            onDoubleClick={paneLayout.collapseRightPane}
          />
        )}
      </section>
      {!paneLayout.leftCollapsed && (
        <div
          className={paneLayout.leftHandleClassName}
          role="separator"
          aria-label="调整左侧项目栏宽度"
          aria-orientation="vertical"
          title={paneLayout.collapsePreviewSide === 'left' ? '松开将折叠' : '拖拽调整左侧项目栏宽度，双击折叠'}
          onMouseDown={(event) => paneLayout.startPaneResize('left', event)}
          onDoubleClick={paneLayout.collapseLeftPane}
        />
      )}
      {paneLayout.leftCollapsed && (
        <div
          className="left-preview-hotzone"
          onMouseEnter={paneLayout.openLeftPreviewLater}
          onMouseLeave={paneLayout.closeLeftPreviewLater}
          onDoubleClick={paneLayout.expandLeftPane}
          aria-hidden="true"
        />
      )}
      {paneLayout.leftCollapsed && paneLayout.leftPreviewMounted && (
        <div
          className={paneLayout.leftPreviewClassName}
          onMouseEnter={paneLayout.keepLeftPreviewOpen}
          onMouseLeave={paneLayout.closeLeftPreviewLater}
        >
          <ProjectPane
            variant="preview"
            onClosePreview={paneLayout.closeLeftPreview}
            desktopState={app.desktopState}
            projects={app.displayedProjects}
            selectedProject={app.selectedProject}
            selectedSession={app.selectedSession}
            sessionsForProject={app.sessionsForProject}
            expandedProjectPaths={app.expandedProjectPaths}
            onSelectWorkspace={() => {
              paneLayout.closeLeftPreview();
              void projectActions.handleSelectWorkspace();
            }}
            onToggleProjectExpanded={projectActions.toggleProjectExpanded}
            onNewSession={() => {
              paneLayout.closeLeftPreview();
              void sessionLifecycle.handleNewSession();
            }}
            onNewProjectSession={(project) => {
              paneLayout.closeLeftPreview();
              void sessionLifecycle.handleNewSession(project);
            }}
            onOpenSessionSearch={() => {
              paneLayout.closeLeftPreview();
              app.setSessionSearchOpen(true);
            }}
            onSyncSessions={() => {
              paneLayout.closeLeftPreview();
              if (app.selectedProject) {
                void sessionLifecycle.syncProjectSessions(app.selectedProject.path);
              }
            }}
            onSelectProjectSession={(project, session) => {
              paneLayout.closeLeftPreview();
              void sessionLifecycle.handleSelectProjectSession(project, session);
            }}
            onToggleProjectPinned={(project) => {
              paneLayout.closeLeftPreview();
              void projectActions.handleToggleProjectPinned(project);
            }}
            onRevealProject={(project) => {
              paneLayout.closeLeftPreview();
              void projectActions.handleRevealProject(project);
            }}
            onRenameProject={(project, name) => {
              paneLayout.closeLeftPreview();
              void projectActions.handleRenameProject(project, name);
            }}
            onRemoveProject={(project) => {
              paneLayout.closeLeftPreview();
              void projectActions.handleRemoveProject(project);
            }}
            onForkSession={(project, session) => {
              paneLayout.closeLeftPreview();
              void sessionLifecycle.handleForkSession(project, session);
            }}
            onCloseSession={(project, session) => {
              paneLayout.closeLeftPreview();
              void sessionLifecycle.handleCloseSession(session);
            }}
          />
        </div>
      )}

      <StatusBar selectedProject={app.selectedProject} hasDiff={Boolean(app.diffText)} />

      {app.sessionSearchOpen && (
        <SessionSearchModal
          items={app.sessionSearchItems}
          currentProjectPath={app.selectedProject?.path}
          onClose={() => app.setSessionSearchOpen(false)}
          onSelect={(project, session) => void sessionLifecycle.handleSelectProjectSession(project, session)}
        />
      )}

      {app.gitBranchSwitchError && (
        <GitBranchSwitchErrorModal error={app.gitBranchSwitchError} onClose={gitReview.closeGitBranchSwitchError} />
      )}

      {app.activeApprovalKind === 'permission' && app.permissionRequest && (
        <PermissionModal request={app.permissionRequest} onRespond={(optionId) => void approvalFlow.handlePermission(optionId)} />
      )}

      {app.activeApprovalKind === 'elicitation' && app.elicitationRequest && (
        <ElicitationModal
          request={app.elicitationRequest}
          onRespond={(action, content) => void approvalFlow.handleElicitation(app.elicitationRequest!.requestId, action, content)}
        />
      )}

      {app.activeApprovalKind === 'questionnaire' && app.questionnaireRequest && (
        <QuestionnaireModal
          key={app.questionnaireRequest.requestId}
          request={app.questionnaireRequest}
          requests={app.questionnaireBySession.current[app.selectedSession?.id ?? ''] ?? []}
          onSelect={app.setQuestionnaireRequest}
          onRespond={(action, answers) => approvalFlow.handleQuestionnaire(app.questionnaireRequest!.requestId, action, answers)}
        />
      )}

    </main>
  );
}
