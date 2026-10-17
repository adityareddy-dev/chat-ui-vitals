/** Proposed `gen_ai.ui.*` names are not in the registry. Registered names are called out in the design. */
export const SPAN_NAME = 'gen_ai.ui.chat';

export const METRIC = {
  firstChunk: 'gen_ai.ui.time_to_first_chunk',
  firstPaint: 'gen_ai.ui.time_to_first_painted_token',
  streamDuration: 'gen_ai.ui.stream.duration',
  perChunk: 'gen_ai.ui.time_per_output_chunk',
} as const;

export const ATTR = {
  sessionId: 'session.id',
  conversationId: 'gen_ai.conversation.id',
  requestModel: 'gen_ai.request.model',
  providerName: 'gen_ai.provider.name',
  requestStream: 'gen_ai.request.stream',
  responseId: 'gen_ai.response.id',
  previousResponseId: 'gen_ai.request.previous_response.id',
  errorType: 'error.type',
  httpMethod: 'http.request.method',
  urlFull: 'url.full',
  serverAddress: 'server.address',
  serverPort: 'server.port',
  firstChunk: 'gen_ai.ui.time_to_first_chunk',
  firstPaint: 'gen_ai.ui.time_to_first_painted_token',
  chunkCount: 'gen_ai.ui.chunk.count',
  userAction: 'gen_ai.ui.user_action.name',
  loafDuration: 'gen_ai.ui.long_animation_frame.duration_ms',
  vitalName: 'browser.web_vital.name',
  vitalValue: 'browser.web_vital.value',
  evaluationName: 'gen_ai.evaluation.name',
  evaluationScore: 'gen_ai.evaluation.score.value',
  evaluationLabel: 'gen_ai.evaluation.score.label',
  evaluatorType: 'evaluator.type',
} as const;

export const EVENT = {
  userAction: 'gen_ai.ui.user_action',
  loaf: 'gen_ai.ui.long_animation_frame',
  inp: 'gen_ai.ui.inp',
  event: 'gen_ai.ui.event',
  evaluation: 'gen_ai.evaluation.result',
} as const;

export const RESPONSE_HEADER = 'x-gen-ai-response-id';
export const BLAME_PREFIX = 'react_inp_blame.';
export const EVALUATION_NAME = 'user_feedback';

/** Same explicit bounds as the GenAI inference timing histograms, in seconds. */
export const BUCKETS = [0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92];
