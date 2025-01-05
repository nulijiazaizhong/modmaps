#include <napi.h>
#include "libdeflate.h"

template<>
struct std::default_delete<libdeflate_gdeflate_decompressor> {
    void operator()(libdeflate_gdeflate_decompressor* p) const {
        libdeflate_free_gdeflate_decompressor(p);
    }
};

template<>
struct std::default_delete<libdeflate_decompressor> {
    void operator()(libdeflate_decompressor* p) const {
        libdeflate_free_decompressor(p);
    }
};

Napi::Value GDeflate(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() != 2) {
    Napi::TypeError::New(env, "Wrong number of arguments").ThrowAsJavaScriptException();
    return env.Null();
  }
  if (!info[0].IsArrayBuffer() || !info[1].IsArrayBuffer()) {
    Napi::TypeError::New(env, "Arguments must be array buffers").ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::ArrayBuffer inputBuffer = info[0].As<Napi::ArrayBuffer>();
  Napi::ArrayBuffer outputBuffer = info[1].As<Napi::ArrayBuffer>();

  libdeflate_gdeflate_in_page compressedPage{};
  compressedPage.data = inputBuffer.Data();
  compressedPage.nbytes = inputBuffer.ByteLength();

  std::unique_ptr<libdeflate_gdeflate_decompressor> decompressor(libdeflate_alloc_gdeflate_decompressor());
  Napi::Number result = Napi::Number::New(env, libdeflate_gdeflate_decompress(
    decompressor.get(),
    &compressedPage,
    1,
    outputBuffer.Data(),
    outputBuffer.ByteLength(),
    nullptr
  ));

  return result;
}

Napi::Value Deflate(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() != 2) {
        Napi::TypeError::New(env, "Wrong number of arguments").ThrowAsJavaScriptException();
        return env.Null();
    }
    if (!info[0].IsArrayBuffer() || !info[1].IsArrayBuffer()) {
        Napi::TypeError::New(env, "Arguments must be array buffers").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::ArrayBuffer inputBuffer = info[0].As<Napi::ArrayBuffer>();
    Napi::ArrayBuffer outputBuffer = info[1].As<Napi::ArrayBuffer>();

    std::unique_ptr<libdeflate_decompressor> decompressor(libdeflate_alloc_decompressor());
    Napi::Number result = Napi::Number::New(env, libdeflate_deflate_decompress(
        decompressor.get(),
        inputBuffer.Data(),
        inputBuffer.ByteLength(),
        outputBuffer.Data(),
        outputBuffer.ByteLength(),
        nullptr
    ));

    return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set(Napi::String::New(env, "gdeflate"), Napi::Function::New(env, GDeflate));
  exports.Set(Napi::String::New(env, "deflate"), Napi::Function::New(env, Deflate));
  return exports;
}

NODE_API_MODULE(addon, Init)