export class ContractValidationError extends Error {
  constructor(message = "Invalid Host RPC reply") {
    super(message);
    this.name = "ContractValidationError";
  }
}
