from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parent.parent
SIZE = 1024
ICON_SIZES = (16, 24, 32, 48, 64, 128, 256)


def make_icon():
    # Draw at 4x the largest exported size for smooth small-size edges.
    image = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((32, 32, 992, 992), radius=224, fill='#4671e8')

    # An open counter and substantial tail keep the Q distinct from O at 32px.
    q_mask = Image.new('L', image.size, 0)
    q = ImageDraw.Draw(q_mask)
    q.ellipse((142, 284, 484, 702), fill=255)
    q.ellipse((232, 374, 394, 612), fill=0)
    q.polygon(((368, 558), (507, 704), (459, 750), (320, 604)), fill=255)
    image.paste('#ffffff', (0, 0, SIZE, SIZE), q_mask)

    # Wide, flat-ended X strokes remain readable beside the white Q.
    draw = ImageDraw.Draw(image)
    draw.polygon(
        ((550, 294), (655, 294), (710, 410), (770, 294),
         (875, 294), (766, 491), (882, 704), (776, 704),
         (710, 567), (643, 704), (538, 704), (654, 491)),
        fill='#dceaff',
    )
    return image


def main():
    image = make_icon()
    image.resize((256, 256), Image.Resampling.LANCZOS).save(ROOT / 'src' / 'icon.png')
    image.save(ROOT / 'assets' / 'icon.ico', sizes=[(size, size) for size in ICON_SIZES])
    print('QX application icons generated (PNG: 256px; ICO: 16–256px)')


if __name__ == '__main__':
    main()
