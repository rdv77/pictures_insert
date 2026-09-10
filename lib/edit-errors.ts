export type EditStage = 'read_inputs' | 'request_xai' | 'read_response' | 'decode_response' | 'download_result' | 'validate_result' | 'save_result' | 'save_status';
export function editFailure(stage: EditStage, error: unknown) {
  const name = error instanceof Error ? error.name : 'UnknownError';
  const timeout = name === 'TimeoutError' || name === 'AbortError';
  const messages: Record<EditStage, string> = {
    read_inputs: 'Не удалось прочитать исходные файлы. Запрос к xAI ещё не отправлялся.',
    request_xai: timeout ? 'xAI не ответил за 4 минуты. Запрос мог быть оплачен.' : 'Не удалось получить ответ от API xAI. Запрос мог быть принят и оплачен.',
    read_response: 'Ответ xAI начал поступать, но не был прочитан полностью. Запрос мог быть оплачен.',
    decode_response: 'xAI вернул ответ, который не удалось разобрать как JSON. Запрос мог быть оплачен.',
    download_result: 'xAI вернул ссылку, но скачать готовое изображение не удалось. Генерация могла быть оплачена.',
    validate_result: 'Не удалось распознать изображение в ответе xAI. Запрос мог быть оплачен.',
    save_result: 'Ответ xAI получен, но не удалось сохранить изображение в хранилище.',
    save_status: 'Изображение сохранено, но не удалось обновить статус задания. При следующем запуске приложение сначала проверит сохранённый результат.',
  };
  return `${messages[stage]} Автоматического повтора нет. Код: ${stage}${timeout ? '_timeout' : ''}.`;
}
export function errorKind(error: unknown) {
  // Do not log error.message/cause: SDKs may embed keys, data URIs or signed URLs.
  return error instanceof Error && ['TypeError','SyntaxError','TimeoutError','AbortError','Error','RangeError'].includes(error.name) ? error.name : 'UnknownError';
}
