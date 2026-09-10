import { TestBed } from '@angular/core/testing';
import { Payments } from './payments';

describe('Payments', () => {
  let service: Payments;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(Payments);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
