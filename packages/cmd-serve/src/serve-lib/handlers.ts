import type { IncomingMessage, ServerResponse } from "node:http";
import { handleRegister, handleDeregister } from "./handlers/register.js";
import { handleStatus, handleStop, handleHealthCheck } from "./handlers/status.js";
import { handleListScenarios, handleStartScenario, handleStopScenario, handleScenarioRuns } from "./handlers/scenarios.js";
import { handleDashboard, handleScenarioView, handleFlows, handleFlowView, handleFlowReportView } from "./handlers/views.js";
import { handleStartFlow, handleFlowRuns, handleOpenReportFile, handleFlowEvidence } from "./handlers/flows.js";
import { handleManualFlowView, handleManualFlowSubmit, handleManualEvidenceUpload } from "./handlers/manualFlow.js";
import type { ServeContext } from "./types.js";

export class ServeHandlers {
  constructor(private readonly ctx: ServeContext) {}

  register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return handleRegister(this.ctx, req, res);
  }

  deregister(url: URL, res: ServerResponse): void {
    handleDeregister(this.ctx, url, res);
  }

  status(res: ServerResponse): void {
    handleStatus(this.ctx, res);
  }

  stop(res: ServerResponse): void {
    handleStop(this.ctx, res);
  }

  healthCheck(url: URL, res: ServerResponse): Promise<void> {
    return handleHealthCheck(this.ctx, url, res);
  }

  listScenarios(res: ServerResponse): Promise<void> {
    return handleListScenarios(this.ctx, res);
  }

  startScenario(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return handleStartScenario(this.ctx, req, res);
  }

  stopScenario(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return handleStopScenario(this.ctx, req, res);
  }

  scenarioRuns(res: ServerResponse): void {
    handleScenarioRuns(this.ctx, res);
  }

  dashboard(res: ServerResponse): Promise<void> {
    return handleDashboard(this.ctx, res);
  }

  flows(res: ServerResponse): Promise<void> {
    return handleFlows(this.ctx, res);
  }

  flowView(url: URL, res: ServerResponse): Promise<void> {
    return handleFlowView(this.ctx, url, res);
  }

  flowReportView(url: URL, res: ServerResponse): Promise<void> {
    return handleFlowReportView(this.ctx, url, res);
  }

  startFlow(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return handleStartFlow(this.ctx, req, res);
  }

  flowRuns(res: ServerResponse): void {
    handleFlowRuns(this.ctx, res);
  }

  manualFlowView(url: URL, res: ServerResponse): Promise<void> {
    return handleManualFlowView(this.ctx, url, res);
  }

  manualFlowSubmit(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return handleManualFlowSubmit(this.ctx, req, res);
  }

  manualEvidenceUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return handleManualEvidenceUpload(this.ctx, req, res);
  }

  openReportFile(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return handleOpenReportFile(this.ctx, req, res);
  }

  flowEvidence(url: URL, res: ServerResponse): void {
    handleFlowEvidence(this.ctx, url, res);
  }

  scenarioView(url: URL, res: ServerResponse): Promise<void> {
    return handleScenarioView(this.ctx, url, res);
  }
}
