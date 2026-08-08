/**
 * Domain errors. Each carries a stable `code` so the HTTP layer can map it to a
 * status and the UI can react to it without string-matching a message.
 */

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** A request that is well-formed but cannot be satisfied by the current state. */
export class ConflictError extends DomainError {}

/** A request whose inputs are invalid regardless of state. */
export class ValidationError extends DomainError {}

export class NotFoundError extends DomainError {
  constructor(entity: string, id: string) {
    super('not_found', `${entity} ${id} does not exist`, { entity, id });
  }
}
