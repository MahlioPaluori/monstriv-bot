export default async function handler(req, res) {
  const { code, error, error_description } = req.query;

  if (error) {
    console.error("Meta OAuth callback error:", {
      error,
      error_description,
    });

    return res.status(400).send(`
      <html>
        <body style="font-family: sans-serif; padding: 24px;">
          <h2>Meta onboarding error</h2>
          <p>${error}</p>
          <p>${error_description || ""}</p>
        </body>
      </html>
    `);
  }

  if (!code) {
    return res.status(400).send(`
      <html>
        <body style="font-family: sans-serif; padding: 24px;">
          <h2>Meta onboarding callback</h2>
          <p>No authorization code was provided.</p>
        </body>
      </html>
    `);
  }

  console.log("Meta Embedded Signup callback received", {
    hasCode: true,
  });

  return res.status(200).send(`
    <html>
      <body style="font-family: sans-serif; padding: 24px;">
        <h2>Meta onboarding completed</h2>
        <p>Authorization code received successfully.</p>
        <p>You can close this window and return to Meta.</p>
      </body>
    </html>
  `);
}
