exports.handler = async () => ({
  statusCode: 200,
  headers: {'Content-Type':'application/json'},
  body: JSON.stringify({ hasKey: !!process.env.OPENAI_API_KEY })
});
