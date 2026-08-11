import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";

type ErrorEnvelope = { statusCode: number; error: string; message: string | string[] };

@Catch()
export class AdminExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{ status(code: number): { json(body: ErrorEnvelope): void } }>();
    const envelope = this.toEnvelope(exception);
    response.status(envelope.statusCode).json(envelope);
  }

  private toEnvelope(exception: unknown): ErrorEnvelope {
    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      return {
        statusCode,
        error: this.label(statusCode),
        message: statusCode === HttpStatus.UNPROCESSABLE_ENTITY
          ? this.validationMessage(exception.getResponse())
          : this.genericMessage(statusCode),
      };
    }

    const code = this.prismaCode(exception);
    if (code === "P2002" || code === "P2003") {
      return { statusCode: HttpStatus.CONFLICT, error: "Conflict", message: "Resource conflict" };
    }
    if (code === "P2025") {
      return { statusCode: HttpStatus.NOT_FOUND, error: "Not Found", message: "Resource not found" };
    }
    return { statusCode: HttpStatus.INTERNAL_SERVER_ERROR, error: "Internal Server Error", message: "Internal server error" };
  }

  private prismaCode(exception: unknown): string | undefined {
    if (exception === null || typeof exception !== "object") return undefined;
    const code = (exception as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }

  private validationMessage(payload: string | object): string | string[] {
    if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
      const message = (payload as Record<string, unknown>).message;
      if (typeof message === "string") return message;
      if (Array.isArray(message) && message.every((item) => typeof item === "string")) return message;
    }
    return typeof payload === "string" ? payload : "Validation failed";
  }

  private genericMessage(statusCode: number): string {
    switch (statusCode) {
      case HttpStatus.BAD_REQUEST: return "Bad request";
      case HttpStatus.UNAUTHORIZED: return "Unauthorized";
      case HttpStatus.FORBIDDEN: return "Forbidden";
      case HttpStatus.NOT_FOUND: return "Resource not found";
      case HttpStatus.CONFLICT: return "Resource conflict";
      case HttpStatus.TOO_MANY_REQUESTS: return "Too many requests";
      default: return statusCode >= 500 ? "Internal server error" : "Request failed";
    }
  }

  private label(statusCode: number): string {
    return HttpStatus[statusCode]
      ? String(HttpStatus[statusCode]).toLowerCase().replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
      : "Error";
  }
}
