import math
import struct
import zlib
import os

def make_png(width, height, pixels):
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    
    raw = b''.join(b'\x00' + b''.join(pixels[y*width + x] for x in range(width)) for y in range(height))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')

def render_icon(size):
    pixels = []
    center = size / 2.0
    radius = size * 0.46
    
    # Theme colors
    bg_dark = (26, 27, 38)        # Dark navy/slate #1a1b26
    accent_cyan = (99, 102, 241)   # Indigo/purple accent #6366f1
    lens_color = (56, 189, 248)    # Sky blue #38bdf8
    white = (248, 250, 252)        # White #f8fafc

    for y in range(size):
        for x in range(size):
            dx = x - center + 0.5
            dy = y - center + 0.5
            dist = math.sqrt(dx*dx + dy*dy)
            
            if dist > radius + 0.5:
                # Outside circle
                pixels.append(struct.pack('BBBB', 0, 0, 0, 0))
                continue
            
            # Anti-aliasing border
            alpha = 255
            if dist > radius - 0.5:
                alpha = int(255 * (radius + 0.5 - dist))
            
            # Normalized coordinates (-1 to 1)
            nx = dx / radius
            ny = dy / radius
            
            r, g, b = bg_dark
            
            # Fedora hat crown (top trapezoid)
            # ny between -0.65 and -0.25, nx between -0.45 and 0.45
            in_hat_crown = False
            if -0.62 <= ny <= -0.22:
                half_w = 0.32 - (ny + 0.62) * 0.12
                if abs(nx) <= half_w:
                    in_hat_crown = True
            
            # Hat brim
            in_hat_brim = False
            if -0.24 <= ny <= -0.14:
                if abs(nx) <= 0.65:
                    # slight curve up at edges
                    curve = (abs(nx) / 0.65) ** 2 * 0.05
                    if ny - curve <= -0.16:
                        in_hat_brim = True

            # Hat ribbon
            in_hat_ribbon = False
            if -0.30 <= ny <= -0.22 and in_hat_crown:
                in_hat_ribbon = True

            # Glasses / Sunglasses
            # Left lens: nx in [-0.48, -0.08], ny in [-0.02, 0.28]
            # Right lens: nx in [0.08, 0.48], ny in [-0.02, 0.28]
            # Bridge: nx in [-0.10, 0.10], ny in [0.04, 0.10]
            in_glasses = False
            in_lens = False
            
            for side in (-1, 1):
                lx = nx - side * 0.27
                ly = ny - 0.12
                # Lens ellipse / rounded rect
                ell = (lx / 0.19)**2 + (ly / 0.14)**2
                if ell <= 1.0:
                    in_glasses = True
                    if ell <= 0.72:
                        in_lens = True

            # Glasses bridge
            if abs(nx) <= 0.10 and 0.04 <= ny <= 0.10:
                in_glasses = True

            if in_hat_ribbon:
                r, g, b = accent_cyan
            elif in_hat_crown or in_hat_brim:
                r, g, b = white
            elif in_lens:
                r, g, b = lens_color
            elif in_glasses:
                r, g, b = white

            pixels.append(struct.pack('BBBB', r, g, b, alpha))

    return make_png(size, height=size, pixels=pixels)

os.makedirs('icons', exist_ok=True)
for s in [16, 48, 128]:
    data = render_icon(s)
    path = os.path.join('icons', f'icon{s}.png')
    with open(path, 'wb') as f:
        f.write(data)
    print(f'Wrote {path} ({len(data)} bytes)')
