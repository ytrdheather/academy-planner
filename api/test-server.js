import http from 'http';

const server = http.createServer((req, res) => {
  // 어떤 요청이든 받으면, 터미널에 로그를 표시합니다.
  console.log(`\n--- 요청 받음! ---`);
  console.log(`시간: ${new Date().toLocaleTimeString()}`);
  console.log(`주소 (URL): ${req.url}`);
  console.log(`방식 (Method): ${req.method}`);
  console.log(`------------------`);

  // 브라우저에게 간단한 성공 메시지를 보냅니다.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');

  // OPTIONS 요청에 대한 사전 처리 (CORS)
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ message: '테스트 서버가 응답했습니다!' }));
});

server.listen(5001, '127.0.0.1', () => {
  console.log('✅ 테스트 서버가 http://localhost:5001 에서 실행 중입니다.');
  console.log('브라우저에서 로그인을 시도하면, 여기에 메시지가 나타나야 합니다...');
});