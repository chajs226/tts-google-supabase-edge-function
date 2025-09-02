import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// Google Cloud Text-to-Speech API 호출을 위한 Edge Function
Deno.serve(async (req)=>{
  // 향상된 CORS 헤더 설정
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-requested-with',
    'Access-Control-Max-Age': '86400'
  };
  // OPTIONS 요청 처리 (CORS preflight)
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }
  // POST 요청만 허용
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({
      success: false,
      error: 'Method not allowed. Only POST requests are accepted.'
    }), {
      status: 405,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
  try {
    // 요청 본문 파싱 및 검증
    let requestBody;
    try {
      requestBody = await req.json();
    } catch (parseError) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Invalid JSON in request body.'
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const { text, fileName } = requestBody;
    // 입력 검증
    if (!text || typeof text !== 'string') {
      return new Response(JSON.stringify({
        success: false,
        error: 'Text parameter is required and must be a string.'
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    if (!fileName || typeof fileName !== 'string') {
      return new Response(JSON.stringify({
        success: false,
        error: 'FileName parameter is required and must be a string.'
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // 텍스트 길이 제한 (Google TTS 제한 고려)
    if (text.length > 5000) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Text is too long. Maximum length is 5000 characters.'
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    console.log(`Processing TTS request - Text length: ${text.length}, File: ${fileName}`);
    // Google Cloud TTS API 호출
    const ttsRequest = {
      input: {
        text: text
      },
      voice: {
        languageCode: "en-US",
        name: "en-US-Neural2-J",
        ssmlGender: "MALE"
      },
      audioConfig: {
        audioEncoding: "MP3",
        speakingRate: 0.95,
        pitch: -2.0
      }
    };
    // Google Cloud API 키 환경변수 확인
    const apiKey = Deno.env.get('GOOGLE_CLOUD_API_KEY');
    if (!apiKey) {
      console.error('GOOGLE_CLOUD_API_KEY environment variable not set');
      return new Response(JSON.stringify({
        success: false,
        error: 'TTS service configuration error.'
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Google Cloud TTS API 호출
    const response = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(ttsRequest)
    });
    const ttsResponse = await response.json();
    if (!response.ok) {
      console.error('Google TTS API error:', ttsResponse);
      return new Response(JSON.stringify({
        success: false,
        error: `TTS generation failed: ${ttsResponse.error?.message || 'Unknown error'}`
      }), {
        status: response.status,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Base64 디코딩하여 오디오 바이너리 데이터 생성
    if (!ttsResponse.audioContent) {
      return new Response(JSON.stringify({
        success: false,
        error: 'No audio content received from TTS service.'
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const audioContent = atob(ttsResponse.audioContent);
    const audioBuffer = new Uint8Array(audioContent.length);
    for(let i = 0; i < audioContent.length; i++){
      audioBuffer[i] = audioContent.charCodeAt(i);
    }
    console.log(`Audio generated successfully - Size: ${audioBuffer.length} bytes`);
    // Supabase Storage에 업로드
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseKey) {
      console.error('Supabase environment variables not set');
      return new Response(JSON.stringify({
        success: false,
        error: 'Storage service configuration error.'
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const supabase = createClient(supabaseUrl, supabaseKey);
    // 파일명 정리 (특수문자 제거)
    const cleanFileName = fileName.replace(/[^a-zA-Z0-9-_]/g, '_');
    const fullFileName = `${cleanFileName}.mp3`;
    const { data: uploadData, error: uploadError } = await supabase.storage.from('audio-files').upload(fullFileName, audioBuffer, {
      contentType: 'audio/mpeg',
      upsert: true // 같은 파일명이 있으면 덮어쓰기
    });
    if (uploadError) {
      console.error('Storage upload error:', uploadError);
      return new Response(JSON.stringify({
        success: false,
        error: `File upload failed: ${uploadError.message}`
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // 공개 URL 생성
    const { data: urlData } = supabase.storage.from('audio-files').getPublicUrl(fullFileName);
    console.log(`File uploaded successfully: ${urlData.publicUrl}`);
    // 성공 응답
    return new Response(JSON.stringify({
      success: true,
      audioUrl: urlData.publicUrl,
      fileName: fullFileName,
      textLength: text.length,
      audioSize: audioBuffer.length,
      timestamp: new Date().toISOString()
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('Unexpected error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'An unexpected error occurred while processing your request.',
      details: error.message
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
}); /*
필요한 환경 변수:
- GOOGLE_CLOUD_API_KEY: Google Cloud TTS API 키
- SUPABASE_URL: Supabase 프로젝트 URL  
- SUPABASE_SERVICE_ROLE_KEY: Supabase Service Role 키

설정 방법:
supabase secrets set GOOGLE_CLOUD_API_KEY=your_google_api_key
supabase secrets set SUPABASE_URL=https://your-project.supabase.co
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
*/ 
