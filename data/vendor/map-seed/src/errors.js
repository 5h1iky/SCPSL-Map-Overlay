export class MapGenerationError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = 'MapGenerationError';
    this.context = context;
  }
}
