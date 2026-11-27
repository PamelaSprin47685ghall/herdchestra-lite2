// Root rewind: take the live session back to a plan's start point, then resume.
//
// This is the only ticket that mutates the transcript, so its ordering carries
// the correctness. It runs detached from `agent_end` (which must never await its
// own idle barrier), it claims the run hold synchronously before its first
// await, and it commits only when the plan still owns the station. The commit
// check, the transcript mutation, and the resume request therefore happen with
// no yield between them.

import { hasScopeReturnStop, takeScopeReturnRunHold } from "../branch-context.mjs";
import { managerOf, sessionOf } from "../adapter.mjs";
import { record } from "../diagnostics.mjs";

function supportsRootRewind(pi, session, manager) {
	return Boolean(
		session && manager && manager === session.sessionManager &&
		!session.isDisposed && !session.isSessionTransitioning &&
		typeof session.withQueueDrainPaused === "function" &&
		typeof session.waitForIdle === "function" &&
		typeof session.settleInFlightMessagePersistence === "function" &&
		(typeof session.prompt === "function" || typeof pi?.sendUserMessage === "function") &&
		typeof manager.getSessionId === "function" &&
		typeof manager.getLeafId === "function" &&
		typeof manager.getBranch === "function" &&
		typeof manager.appendCompaction === "function" &&
		typeof manager.appendMessage === "function" &&
		typeof manager.buildSessionContext === "function" &&
		Array.isArray(session.agent?.state?.messages) && hasScopeReturnStop(session.agent),
	);
}

/** Whether a root rewind can run against this context. */
export function canRewindRoot(pi, ctx) {
	return supportsRootRewind(pi, sessionOf(ctx), managerOf(ctx));
}

function rootRewindStillPending(station, plan) {
	const pending = station?.state?.relay?.pendingRewind ?? null;
	if (!pending || !plan) return false;
	return pending === plan.pending ||
		(pending.generation === plan.generation && (pending.id ?? null) === (plan.id ?? null));
}

function rewindErrorAssistant(session, reason) {
	const model = session?.model ?? session?.agent?.state?.model ?? null;
	const now = Date.now();
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: model?.api ?? "unknown",
		provider: model?.provider ?? "unknown",
		model: model?.id ?? model?.model ?? "unknown",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: `Root rewind takeover failed: ${reason}`,
		timestamp: now,
		completedAt: now,
	};
}

/**
 * Surface a root rewind takeover failure to the host so non-interactive print
 * mode does not exit silently with code 0. Only writes to the original live
 * session; never pollutes a disposed or switched session.
 */
async function reportRootRewindFailure(station, session, manager, reason, cause = null) {
	const error = cause instanceof Error ? cause : new Error(`Root rewind takeover failed: ${reason}`);
	record("handoff", error, { phase: "rewind-takeover", reason });
	station?.noteError?.("handoff", error, { phase: "rewind-takeover", reason });
	if (!session || session.isDisposed || session.isSessionTransitioning) return;
	const failureMessage = rewindErrorAssistant(session, reason);
	try {
		if (typeof session.agent?.emitExternalEvent === "function") {
			session.agent.emitExternalEvent({ type: "message_start", message: failureMessage });
			session.agent.emitExternalEvent({ type: "message_end", message: failureMessage });
			if (typeof session.settleInFlightMessagePersistence === "function") {
				await session.settleInFlightMessagePersistence();
			}
			return;
		}
		if (typeof session.agent?.appendMessage === "function") {
			session.agent.appendMessage(failureMessage);
		} else if (Array.isArray(session.agent?.state?.messages)) {
			session.agent.state.messages.push(failureMessage);
		}
		if (manager && typeof manager.appendMessage === "function") {
			manager.appendMessage(failureMessage);
		}
	} catch (emitError) {
		record("handoff", emitError, { phase: "rewind-failure-report", reason });
	}
}

function sameLiveSession(ctx, station, session, manager, agent, sessionId, epoch) {
	return Boolean(
		session && !session.isDisposed && !session.isSessionTransitioning &&
		session.agent === agent && session.transcriptEpoch === epoch &&
		sessionOf(ctx) === session && managerOf(ctx) === manager &&
		manager === session.sessionManager && station.manager === manager &&
		typeof manager.getSessionId === "function" && manager.getSessionId() === sessionId,
	);
}

/** Run detached from agent_end, which must never await its own idle barrier. */
export async function rewindRootTicket(pi, station, ctx, plan) {
	const session = sessionOf(ctx);
	const manager = managerOf(ctx);
	// Claim ownership of the run-active hold synchronously before any await so
	// `hooks.mjs`'s agent_end finally block does not release it prematurely.
	const runHold = takeScopeReturnRunHold(session);
	let releaseRunHold = () => {
		runHold?.();
	};
	let unsubscribeStart = null;
	const clearStartSub = () => {
		if (typeof unsubscribeStart === "function") {
			const unsub = unsubscribeStart;
			unsubscribeStart = null;
			try { unsub(); } catch {}
		}
	};
	let committed = false;
	let startedResumedTurn = false;
	let takeoverFailure = null;
	try {
		if (!supportsRootRewind(pi, session, manager) || station.manager !== manager) {
			if (session && !session.isDisposed && !session.isSessionTransitioning && rootRewindStillPending(station, plan)) {
				takeoverFailure = { reason: "host session does not support root rewind", cause: null };
			}
			return;
		}
		const sessionId = manager.getSessionId();
		const epoch = session.transcriptEpoch;
		const agent = session.agent;
		let resume;
		let resumeFailed = null;
		await session.withQueueDrainPaused(async () => {
			await session.waitForIdle();
			await session.settleInFlightMessagePersistence();
			if (!sameLiveSession(ctx, station, session, manager, agent, sessionId, epoch)) return;
			if (!supportsRootRewind(pi, session, manager)) {
				if (rootRewindStillPending(station, plan)) {
					takeoverFailure = { reason: "host session lost root rewind capability before commit", cause: null };
				}
				return;
			}
			if (session.isStreaming || session.isAborting || session.hasAdmittedSubmission) {
				if (rootRewindStillPending(station, plan)) {
					const busy = session.isStreaming
						? "streaming"
						: session.isAborting
							? "aborting"
							: "admitted submission active";
					takeoverFailure = { reason: `session remained busy (${busy}) before root rewind commit`, cause: null };
				}
				return;
			}
			// Commit checks that the plan still owns the station. Do not yield
			// between that check, the transcript mutation, and the resume request.
			const wasPending = rootRewindStillPending(station, plan);
			committed = station.commitRootRewind(ctx, plan) === true;
			if (!committed) {
				if (wasPending) {
					takeoverFailure = { reason: "commitRootRewind declined pending plan", cause: null };
				}
				return;
			}
			if (typeof session.subscribe === "function") {
				unsubscribeStart = session.subscribe((event) => {
					if (event?.type === "agent_start") {
						startedResumedTurn = true;
						clearStartSub();
						// The new turn is now live (`isStreaming === true`), so
						// release the run hold before it ends so `session_stop`
						// hooks are not suppressed by a lingering hold job.
						releaseRunHold();
					}
				});
			}
			if (typeof session.prompt !== "function") {
				resume = Promise.resolve(pi.sendUserMessage(plan.startPrompt, { attribution: "agent" }));
				resume.catch((error) => {
					resumeFailed = error;
					record("tickets", error, { kind: "rewind-resume" });
				});
				return;
			}
			// Release the queue hold as soon as the prompt claims the host, or
			// when it fails before admission. Await the actual prompt outside.
			let admitted;
			const admission = new Promise((resolve) => { admitted = resolve; });
			resume = Promise.resolve(session.prompt(plan.startPrompt, {
				synthetic: true,
				attribution: "agent",
				userInitiated: false,
				expandPromptTemplates: false,
				runCommands: false,
				throwOnDrop: true,
				onPromptAdmitted: admitted,
			}));
			resume.then(admitted, (error) => {
				resumeFailed = error;
				admitted();
			});
			await admission;
		});
		if (resume) {
			try {
				await resume;
			} catch (error) {
				resumeFailed = error;
			}
			if (resumeFailed) {
				takeoverFailure = {
					reason: String(resumeFailed?.message ?? resumeFailed ?? "resume prompt rejected"),
					cause: resumeFailed,
				};
			} else if (!startedResumedTurn && typeof session.subscribe === "function" && !session.isDisposed) {
				// `session.prompt` returned cleanly without ever starting a new
				// agent turn (for example, preflight or abort dropped it silently).
				takeoverFailure = { reason: "resumed turn never started after root rewind commit", cause: null };
			}
		}
	} catch (error) {
		takeoverFailure = {
			reason: String(error?.message ?? error ?? "unexpected root rewind error"),
			cause: error,
		};
	} finally {
		clearStartSub();
		if (!committed) station.abortRootRewind?.(plan);
		if (takeoverFailure) {
			await reportRootRewindFailure(
				station,
				session,
				manager,
				takeoverFailure.reason,
				takeoverFailure.cause,
			);
		}
		releaseRunHold();
	}
}
