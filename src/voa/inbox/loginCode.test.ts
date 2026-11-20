import { loginCode, plainHead } from "./loginCode";

/**
 * Shapes taken from the owner's archived mail (Zé, Linear, Shopper, Assis, BTG, Nintendo)
 * plus the Hotmart subject from the inbox screenshot. The digits here are stand-ins.
 */
describe("loginCode", () => {
  it("reads a code from the subject", () => {
    expect(loginCode("Hotmart | 515766 is your login code")).toBe("515766");
    expect(loginCode("Use o código 952292 para configurar o e-mail de recuperação")).toBe("952292");
    expect(loginCode("Use este código para terminar de configurar a conta:\n\n952292")).toBe("952292");
    expect(loginCode("usa el código 952292")).toBe("952292");
    expect(loginCode("código: 952292")).toBe("952292");
    expect(loginCode("código de verificación: 847291")).toBe("847291");
    expect(loginCode("el código es 441290")).toBe("441290");
    expect(loginCode("code: 441290")).toBe("441290");
    expect(loginCode("code 2026")).toBeNull();
  });

  it("reads the codes the archive actually sends", () => {
    expect(
      loginCode("Código de verificação Este é o código para verificar sua entrada no Zé e vale por 1 hora. 610207"),
    ).toBe("610207");
    expect(loginCode("To login to Linear, copy the verification code into your browser: CNR2NHJIM5")).toBe("CNR2NHJIM5");
    expect(loginCode("HKQHXB é o seu código de validação. Código de validação: HKQHXB")).toBe("HKQHXB");
    expect(loginCode("Use o código abaixo para acessar seu painel. 082885 O código expira em 1 hora.")).toBe("082885");
  });

  it("reads a code that the snippet cut off and the body still has", () => {
    const gap = "x".repeat(180);
    expect(loginCode(`Digite o código abaixo. Seu código de verificação: ${gap} 194830`)).toBe("194830");
    expect(
      loginCode(
        "Please enter the following verification code to complete the email address verification process. Verification code: 847291",
      ),
    ).toBe("847291");
  });

  it("stays quiet when the phrase is there and the digits are not", () => {
    expect(loginCode("Digite o código abaixo. Seu código de verificação:")).toBeNull();
  });

  it("ignores mail that says code but is not a login code", () => {
    expect(loginCode("Você está recebendo este e-mail porque usou o recurso Fazer Login com o Google")).toBeNull();
    expect(loginCode("New login to Linear. Login detected with Safari on iOS")).toBeNull();
    expect(loginCode("Código de barras: 846100000005 784500240105")).toBeNull();
    expect(loginCode("Seu código Pix do pedido #2608126YAFDU4V foi gerado")).toBeNull();
    expect(loginCode("Your 30% off code expires today. Use SLOPCOURSE")).toBeNull();
    expect(loginCode("Código de reserva LA9572126BHYY")).toBeNull();
    expect(loginCode("Verifique seus códigos de backup de 2FA")).toBeNull();
    expect(loginCode("The code is: 0153E5-29B8C8-0598D3")).toBeNull();
    expect(loginCode("Thursday meeting. Can we move it to 3pm?")).toBeNull();
    expect(loginCode("")).toBeNull();
  });

  it("prefers the code next to the phrase over a year", () => {
    expect(loginCode("Your login code for 2026 is 515766")).toBe("515766");
  });

  it("does not copy a heading that sits next to the phrase", () => {
    expect(loginCode("ENTRAR NA ASSIS\n\nOlá! Use o código abaixo para acessar seu painel.\n\n082885")).toBe("082885");
  });

  it("reads a code that only exists under an HTML style block", () => {
    const html = `<html><head><style>${"x".repeat(600)}</style></head><body><p>Seu código de verificação</p><p>194830</p></body></html>`;
    expect(loginCode(plainHead(html))).toBe("194830");
  });

  it("ignores a phrase past the first screen of text", () => {
    const html = `<p>${"hello ".repeat(200)}</p><p>Your login code is 515766</p>`;
    expect(loginCode(plainHead(html))).toBeNull();
  });
});
